// Central coordinator: on-install onboarding, and talks to the Claude API via
// a Supabase Edge Function (src/shared/extraction.ts).
//
// Single-click, consent-first protocol (content.ts has the content-script
// half): a trigger click captures one snapshot and asks "Save this job to
// your tracker?" in-page before anything here is contacted. Only "yes"
// sends LIBER_SAVE_REQUESTED — handleSaveRequested resolves it, cheapest
// source first:
//   1. JSON-LD the page already embeds (free, no network);
//   2. the site's stored structure — CSS selectors learned on an earlier
//      visit, run by content.ts against the captured HTML (no Claude call);
//   3. Claude, reading the captured HTML. Its proposed selectors are checked
//      against that same HTML and, if they reproduce its answer, stored as
//      the site's structure so the next visit can use step 2.
// then saves via storage.ts's dedup and reports the outcome back. Every step
// is logged for the on-page capture log button. No persisted per-tab state —
// each accepted click is one bounded async chain independent of tab lifecycle.

import "../../vendor/browser-polyfill.js";
import { addJob, isOnboarded } from "../shared/storage.ts";
import { mergeSnapshot } from "../shared/fieldMerge.ts";
import { appendLog, clearLogsForTab, getLogsForTab } from "../shared/logStorage.ts";
import { extractJobFields } from "../shared/extraction.ts";
import {
  getActiveStructure,
  hostnameOf,
  learnStructure,
  reportStructure,
} from "../shared/siteStructure.ts";
import { hasCoreFields, selectorsReproduce } from "../shared/structure.ts";
import { normalizeScrapedText } from "../shared/textNormalize.ts";
import { ensureSession } from "../shared/supabaseClient.ts";
import type { ExtractionResult, FieldSelectors, JobFieldSnapshot } from "../shared/types.ts";

// Every context always needs a session (anonymous or not) before touching
// entitlements/jobs — fire this once at worker startup rather than once per
// message.
ensureSession().catch(() => {});

function isComplete(snapshot: Partial<JobFieldSnapshot> | null): boolean {
  return !!(snapshot && snapshot.jobTitle && snapshot.company && snapshot.location);
}

function normalizeSnapshot(snapshot: JobFieldSnapshot): JobFieldSnapshot {
  return {
    jobTitle: normalizeScrapedText(snapshot.jobTitle),
    company: normalizeScrapedText(snapshot.company),
    location: normalizeScrapedText(snapshot.location),
  };
}

// Caches extractJobFields' output by exact URL — the same job URL can recur
// across unrelated clicks (e.g. a validation error sends the user back), so
// a repeat request skips the Edge Function call.
const MAX_URL_CACHE_ENTRIES = 50;
const urlExtractionCache = new Map<string, ExtractionResult>();

function cacheExtraction(url: string, result: ExtractionResult): void {
  urlExtractionCache.set(url, result);
  if (urlExtractionCache.size > MAX_URL_CACHE_ENTRIES) {
    urlExtractionCache.delete(urlExtractionCache.keys().next().value!);
  }
}

interface PendingConsentEntry {
  url: string;
  scopeText: string;
  scopeHtml: string;
  structuredSnapshot: JobFieldSnapshot | null;
  capturedAt: number;
}

// Tracks an unanswered consent prompt per tab (set the instant content.ts
// shows it, cleared the instant the user answers) so it can follow a
// redirect/new tab instead of being lost to the old page's teardown.
const pendingConsentByTab = new Map<number, PendingConsentEntry>();

// How long an unanswered prompt stays eligible to resume elsewhere.
const PENDING_CONSENT_TTL_MS = 2 * 60 * 1000;

async function resolvePendingConsentFor(tabId: number): Promise<Omit<
  PendingConsentEntry,
  "capturedAt"
> | null> {
  let sourceTabId = tabId;
  let entry = pendingConsentByTab.get(sourceTabId);

  if (!entry) {
    // Check whether this tab was opened from one with an unanswered prompt
    // (an ATS that opens the real application in a new tab). openerTabId
    // isn't always set — a known gap, not a bug.
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.openerTabId != null) {
        sourceTabId = tab.openerTabId;
        entry = pendingConsentByTab.get(sourceTabId);
      }
    } catch {
      // Tab gone/inaccessible — nothing to resume.
    }
  }

  if (!entry) return null;
  pendingConsentByTab.delete(sourceTabId); // claimed — resumed only once
  if (Date.now() - entry.capturedAt > PENDING_CONSENT_TTL_MS) return null;

  return {
    url: entry.url,
    scopeText: entry.scopeText,
    scopeHtml: entry.scopeHtml,
    structuredSnapshot: entry.structuredSnapshot,
  };
}

type Outcome = "saved" | "duplicate" | "limit" | "failed";

// Fallback OS notification for when content.ts's popup can't be reached
// (tab closed, or navigated to a page content.ts never runs on).
const OUTCOME_NOTIFICATION_TEXT: Record<Outcome, string> = {
  saved: "Job saved. You can check it in your table.",
  duplicate: "This job's already in your tracker.",
  limit: "You've hit the free limit — unlock Liber to keep saving.",
  failed: "Couldn't save this one — try again shortly.",
};

async function showSaveResultNotification(tabId: number, outcome: Outcome): Promise<void> {
  await browser.notifications.create(`liber-result-${tabId}-${Date.now()}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
    title: "Liber",
    message: OUTCOME_NOTIFICATION_TEXT[outcome] || OUTCOME_NOTIFICATION_TEXT.failed,
  });
}

browser.runtime.onInstalled.addListener(async (details: chrome.runtime.InstalledDetails) => {
  if (details.reason === "install") {
    await browser.tabs.create({
      url: browser.runtime.getURL("src/onboarding/onboarding.html"),
    });
  }
});

async function pushExtractionStatus(tabId: number, payload: Record<string, unknown>): Promise<boolean> {
  try {
    await browser.tabs.sendMessage(tabId, { type: "LIBER_EXTRACTION_STATUS", ...payload });
    return true;
  } catch {
    return false; // no content script listening (tab closed, or a restricted page)
  }
}

interface SaveRequest {
  url: string;
  scopeText: string;
  scopeHtml: string;
  structuredSnapshot: JobFieldSnapshot | null;
}

// Asks the tab's content script to run selectors against the captured HTML.
// null = the tab is gone / unreachable, so callers fall back to Claude.
async function runSelectorsInTab(
  tabId: number,
  scopeHtml: string,
  selectors: FieldSelectors,
): Promise<JobFieldSnapshot | null> {
  try {
    return (await browser.tabs.sendMessage(tabId, {
      type: "LIBER_RUN_SELECTORS",
      scopeHtml,
      selectors,
    })) as JobFieldSnapshot;
  } catch {
    return null;
  }
}

// What the on-page capture log shows at the top: how this capture was
// resolved and whether Claude was involved.
interface CaptureSummary {
  hostname: string;
  source: "json-ld" | "structure" | "claude" | "none";
  claude: "called" | "not called" | "free limit reached" | "failed" | "no page content";
  structure: string;
  outcome: string;
}

const CLAUDE_LABEL: Record<ExtractionResult["claude"], CaptureSummary["claude"]> = {
  called: "called",
  quota: "free limit reached",
  error: "failed",
  "empty-input": "no page content",
};

// LIBER_SAVE_REQUESTED handler — the one place extraction/saving happens;
// nothing before this point ever touches Claude or the network.
async function handleSaveRequested(
  tabId: number,
  { url, scopeText, scopeHtml, structuredSnapshot }: SaveRequest,
): Promise<void> {
  pushExtractionStatus(tabId, { phase: "working", progress: 0 });

  const hostname = hostnameOf(url);
  const summary: CaptureSummary = {
    hostname,
    source: "none",
    claude: "not called",
    structure: "none stored for this site",
    outcome: "",
  };
  const log = (step: string, detail: unknown = null) => appendLog({ tabId, url, step, detail });

  let outcome: Outcome;
  try {
    await ensureSession();
    let merged: JobFieldSnapshot = structuredSnapshot || { jobTitle: "", company: "", location: "" };
    if (isComplete(merged)) {
      summary.source = "json-ld";
      await log("fields read from the page's own structured data", merged);
    }

    // Step 2: a structure learned on an earlier visit.
    if (!isComplete(merged) && scopeHtml && hostname) {
      const stored = await getActiveStructure(hostname).catch(async (err) => {
        await log("site structure lookup failed", { message: String(err?.message || err) });
        return null;
      });
      if (stored) {
        const read = await runSelectorsInTab(tabId, scopeHtml, stored.selectors);
        if (read && hasCoreFields(read)) {
          merged = structuredSnapshot ? mergeSnapshot(structuredSnapshot, read).merged : read;
          summary.source = "structure";
          summary.structure = `v${stored.version} used`;
          await log("fields read with the stored site structure (Claude not called)", {
            version: stored.version,
            selectors: stored.selectors,
            read,
          });
          reportStructure(hostname, stored.version, true).catch(() => {});
        } else {
          summary.structure = `v${stored.version} no longer matches`;
          await log("stored site structure found nothing, falling back to Claude", {
            version: stored.version,
            selectors: stored.selectors,
            read,
          });
          reportStructure(hostname, stored.version, false).catch(() => {});
        }
      } else {
        await log("no stored site structure for this site", { hostname });
      }
    }

    // Step 3: Claude. The free-limit quota is enforced server-side inside
    // extract-job-fields; hitting it returns empty fields rather than an error.
    if (!isComplete(merged) && summary.source !== "structure" && (scopeHtml || scopeText)) {
      const cached = urlExtractionCache.get(url);
      let result: ExtractionResult;
      if (cached) {
        result = cached;
        await log("Claude not called: this page was already read this session", cached.snapshot);
      } else {
        await log("calling Claude", {
          hostname,
          htmlChars: scopeHtml.length,
          textChars: scopeText.length,
        });
        result = await extractJobFields({ scopeHtml, scopeText, hostname });
        cacheExtraction(url, result);
        summary.claude = CLAUDE_LABEL[result.claude];
        await log(`Claude ${CLAUDE_LABEL[result.claude]}`, {
          fields: result.snapshot,
          proposedSelectors: result.selectors,
        });
      }

      // mergeSnapshot already prefers a non-empty value over an empty one,
      // so an all-empty result (quota exhausted, or nothing found) just keeps
      // whatever the structured data already had.
      merged = structuredSnapshot
        ? mergeSnapshot(structuredSnapshot, result.snapshot).merged
        : result.snapshot;
      if (hasCoreFields(result.snapshot)) summary.source = "claude";

      // Learn: keep the proposed selectors only if they reproduce Claude's
      // own answer when run against the same captured HTML.
      if (!cached && hasCoreFields(result.snapshot)) {
        if (result.selectors && scopeHtml && hostname) {
          const reread = await runSelectorsInTab(tabId, scopeHtml, result.selectors);
          if (reread && selectorsReproduce(result.selectors, result.snapshot, reread)) {
            try {
              await learnStructure(hostname, result.selectors);
              summary.structure = "learned and stored for next time";
              await log("site structure learned and stored", result.selectors);
            } catch (err) {
              summary.structure = "learned but could not be stored";
              await log("storing the site structure failed", {
                message: String((err as Error)?.message || err),
              });
            }
          } else {
            summary.structure = "proposed selectors did not reproduce the page, not stored";
            await log("proposed selectors did not reproduce Claude's answer, not stored", {
              selectors: result.selectors,
              reread,
            });
          }
        } else {
          summary.structure = "Claude proposed no usable selectors";
        }
      }
    }

    merged = normalizeSnapshot(merged);

    // addJob's own Edge Function call (record-save) is what actually
    // enforces the free job/profile limits — see storage.ts.
    const saved = await addJob(merged);
    outcome = saved.status;
    summary.outcome = outcome;
    await log(`save requested — ${outcome}`, merged);
  } catch (err) {
    await log("save requested — failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    outcome = "failed";
    summary.outcome = "failed";
  }

  await log("capture summary", summary);

  const delivered = await pushExtractionStatus(tabId, { phase: "done", outcome });
  if (!delivered) {
    await showSaveResultNotification(tabId, outcome);
  }
}

browser.runtime.onMessage.addListener((message: any, sender: chrome.runtime.MessageSender) => {
  const tabId = sender.tab?.id;

  // Not `async (message, sender) => {...}` — that always returns a Promise,
  // racing out any other listener for a message type this one doesn't
  // handle. Only the branches below that actually handle a message return
  // a Promise.
  if (message.type === "LIBER_CONSENT_PENDING") {
    if (tabId == null) return;
    pendingConsentByTab.set(tabId, {
      url: message.url,
      scopeText: message.scopeText,
      scopeHtml: message.scopeHtml || "",
      structuredSnapshot: message.structuredSnapshot || null,
      capturedAt: Date.now(),
    });
    return;
  }

  if (message.type === "LIBER_CONSENT_RESOLVED") {
    if (tabId != null) pendingConsentByTab.delete(tabId);
    return;
  }

  if (message.type === "LIBER_CHECK_PENDING_CONSENT") {
    if (tabId == null) return;
    return resolvePendingConsentFor(tabId);
  }

  if (message.type === "LIBER_LOG") {
    return appendLog({
      tabId: tabId ?? null,
      url: message.url,
      step: message.step,
      detail: message.detail ?? null,
    }).then(() => {});
  }

  if (message.type === "LIBER_GET_LOGS") {
    if (tabId == null) return Promise.resolve([]);
    return getLogsForTab(tabId);
  }

  if (message.type === "LIBER_CLEAR_LOGS") {
    if (tabId == null) return;
    return clearLogsForTab(tabId).then(() => {});
  }

  if (message.type === "LIBER_SAVE_REQUESTED") {
    if (tabId == null) return;
    handleSaveRequested(tabId, {
      url: message.url,
      scopeText: message.scopeText,
      scopeHtml: message.scopeHtml || "",
      structuredSnapshot: message.structuredSnapshot || null,
    }).catch(() => {});
    return; // fire-and-forget — result delivered via LIBER_EXTRACTION_STATUS
  }

  if (message.type === "CHECK_ONBOARDED") {
    return isOnboarded();
  }
});

browser.tabs.onRemoved.addListener((tabId: number) => {
  pendingConsentByTab.delete(tabId); // nowhere left to resume once the tab's gone
});
