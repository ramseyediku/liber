// Central coordinator: on-install onboarding, and talks to the Claude API via
// a Supabase Edge Function (src/shared/extraction.ts).
//
// Single-click, consent-first protocol (content.ts has the content-script
// half): a trigger click captures one snapshot and asks "Save this job to
// your tracker?" in-page before anything here is contacted. Only "yes"
// sends LIBER_SAVE_REQUESTED — handleSaveRequested resolves it (JSON-LD
// first, the Edge Function only if still incomplete), saves via storage.ts's
// dedup, and reports the outcome back. No persisted per-tab state — each
// accepted click is one bounded async chain independent of tab lifecycle.

import "../../vendor/browser-polyfill.js";
import { addJob, isOnboarded } from "../shared/storage.ts";
import { mergeSnapshot } from "../shared/fieldMerge.ts";
import { appendLog } from "../shared/logStorage.ts";
import { extractJobFields } from "../shared/extraction.ts";
import { normalizeScrapedText } from "../shared/textNormalize.ts";
import { ensureSession } from "../shared/supabaseClient.ts";
import type { JobFieldSnapshot } from "../shared/types.ts";

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
const urlExtractionCache = new Map<string, JobFieldSnapshot>();

function cacheExtraction(url: string, snapshot: JobFieldSnapshot): void {
  urlExtractionCache.set(url, snapshot);
  if (urlExtractionCache.size > MAX_URL_CACHE_ENTRIES) {
    urlExtractionCache.delete(urlExtractionCache.keys().next().value!);
  }
}

interface PendingConsentEntry {
  url: string;
  scopeText: string;
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

  return { url: entry.url, scopeText: entry.scopeText, structuredSnapshot: entry.structuredSnapshot };
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
  structuredSnapshot: JobFieldSnapshot | null;
}

// LIBER_SAVE_REQUESTED handler — the one place extraction/saving happens;
// nothing before this point ever touches Claude.
async function handleSaveRequested(
  tabId: number,
  { url, scopeText, structuredSnapshot }: SaveRequest,
): Promise<void> {
  pushExtractionStatus(tabId, { phase: "working", progress: 0 });

  let outcome: Outcome;
  try {
    await ensureSession();
    let merged: JobFieldSnapshot = structuredSnapshot || { jobTitle: "", company: "", location: "" };

    if (!isComplete(merged) && scopeText) {
      // The AI-call quota (free limit 10) is enforced server-side now,
      // inside extract-job-fields itself (consume_quota — there's no local
      // table to trigger off of the way jobs/job_profiles have). Hitting it
      // makes the function return empty fields, not an error, so this just
      // falls through to whatever JSON-LD already found — silent, per the
      // schema's own intent (no paywall for this one).
      let llmSnapshot: JobFieldSnapshot;
      if (urlExtractionCache.has(url)) {
        llmSnapshot = urlExtractionCache.get(url)!;
      } else {
        llmSnapshot = await extractJobFields(scopeText);
        cacheExtraction(url, llmSnapshot);
      }
      // mergeSnapshot already prefers a non-empty value over an empty one,
      // so an all-empty llmSnapshot (quota exhausted, or nothing found)
      // just keeps whatever structuredSnapshot already had.
      merged = structuredSnapshot ? mergeSnapshot(structuredSnapshot, llmSnapshot).merged : llmSnapshot;
    }

    merged = normalizeSnapshot(merged);

    // addJob's own Edge Function call (record-save) is what actually
    // enforces the free job/profile limits — see storage.ts.
    const result = await addJob(merged);
    outcome = result.status;
    await appendLog({ tabId, url, step: `save requested — ${outcome}`, detail: merged });
  } catch (err) {
    await appendLog({
      tabId,
      url,
      step: "save requested — failed",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    outcome = "failed";
  }

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

  if (message.type === "LIBER_SAVE_REQUESTED") {
    if (tabId == null) return;
    handleSaveRequested(tabId, {
      url: message.url,
      scopeText: message.scopeText,
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
