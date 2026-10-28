// Central coordinator: on-install onboarding, and talks to the on-device
// LLM (now hosted in an Offscreen Document + Worker — see
// src/shared/llmEngine.js's header for why — via that same module's
// unchanged exported API).
//
// Single-click, consent-first protocol (content.js's header has the
// content-script half): a trigger click captures one snapshot scoped to
// the specific job and asks the user "Save this job to your tracker?"
// entirely in-page, before anything here is ever contacted. Only on "yes"
// does content.js send LIBER_SAVE_REQUESTED — handleSaveRequested below
// resolves it (JSON-LD first, the LLM only if still incomplete), saves via
// storage.js's existing dedup, and reports the real outcome back. There is
// no persisted per-tab state and no multi-step tracking — each accepted
// click is one bounded async chain that runs to completion independent of
// tab lifecycle. See docs/roadmap.md's "Capture flow rewrite: single-click,
// consent-first" for the design history this replaces.

import "../../vendor/browser-polyfill.js";
import { addJob, isOnboarded } from "../shared/storage.js";
import { mergeSnapshot } from "../shared/fieldMerge.js";
import { appendLog } from "../shared/logStorage.js";
import {
  warmup,
  extractJobFields,
  unloadEngine,
  LlmNotReadyError,
} from "../shared/llmEngine.js";
import { getLlmStatus, setLlmStatus } from "../shared/llmStatus.js";
import { normalizeScrapedText } from "../shared/textNormalize.js";

function isComplete(snapshot) {
  return !!(snapshot && snapshot.jobTitle && snapshot.company && snapshot.location);
}

function normalizeSnapshot(snapshot) {
  return {
    jobTitle: normalizeScrapedText(snapshot.jobTitle),
    company: normalizeScrapedText(snapshot.company),
    location: normalizeScrapedText(snapshot.location),
  };
}

// Caches extractJobFields' output by exact page URL, bounded to the most
// recently-used MAX_URL_CACHE_ENTRIES entries — the same job URL can
// recur across unrelated clicks (e.g. a validation error sends the user
// back to retry), so a second request for that URL still skips the LLM.
const MAX_URL_CACHE_ENTRIES = 50;
const urlExtractionCache = new Map();

function cacheExtraction(url, snapshot) {
  urlExtractionCache.set(url, snapshot);
  if (urlExtractionCache.size > MAX_URL_CACHE_ENTRIES) {
    urlExtractionCache.delete(urlExtractionCache.keys().next().value);
  }
}

// How long the LLM can sit idle (no extraction call) before
// liber-llm-idle-check unloads it — see that alarm listener further down.
// Mostly a backstop: maybeUnloadEngineAfter below already unloads
// immediately after every request, so this mainly covers a model preloaded
// (onboarding.js's page-load preload) but never actually used for an
// extraction.
const LLM_IDLE_UNLOAD_MS = 5 * 60 * 1000;
let lastLlmActivityAt = 0;

// Tabs currently in the "extracting" phase (model loading and/or inference
// running) — used two ways: deciding which tabs should receive a live
// progress push when liber_llm_status changes (below), and as the
// safe-unload check just below (so one tab's finished request doesn't yank
// the engine out from under a different tab's still-in-flight one).
const extractingTabs = new Set();

async function maybeUnloadEngineAfter(tabId) {
  for (const id of extractingTabs) {
    if (id !== tabId) return; // another tab still has a request in flight
  }
  await unloadEngine();
  lastLlmActivityAt = 0;
}

// Tracks an unanswered "Save this job to your tracker?" prompt per tab —
// content.js reports one the instant it's shown (LIBER_CONSENT_PENDING) and
// clears it the instant the user answers (LIBER_CONSENT_RESOLVED). This is
// what lets an unanswered prompt follow the user if this tab redirects, or
// the click opened a new tab (e.g. an ATS that routes the real application
// through an intermediate domain, or opens it in a fresh tab), instead of
// just being lost to the old page's teardown — see resolvePendingConsentFor
// below and content.js's beginConsentFlow.
const pendingConsentByTab = new Map();

// How long an unanswered prompt stays eligible to be resumed elsewhere —
// unverified against real redirect/new-tab timing, same "accepted risk,
// bounded" spirit as this project's other heuristic windows. Long enough to
// survive a slow redirect, short enough that a prompt the user actually
// ignored and wandered off from doesn't resurface in an unrelated later tab.
const PENDING_CONSENT_TTL_MS = 2 * 60 * 1000;

async function resolvePendingConsentFor(tabId) {
  let sourceTabId = tabId;
  let entry = pendingConsentByTab.get(sourceTabId);

  if (!entry) {
    // Not pending for this exact tab — check whether this tab was opened
    // (new tab/window) from one that still has an unanswered prompt. Covers
    // an ATS that opens the real application in a new tab rather than
    // redirecting in place. openerTabId isn't always set (e.g. cross-origin
    // without a direct opener relationship) — a known gap, not a bug.
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
  pendingConsentByTab.delete(sourceTabId); // claimed — handed to whichever page asks first, only once
  if (Date.now() - entry.capturedAt > PENDING_CONSENT_TTL_MS) return null;

  return { url: entry.url, scopeText: entry.scopeText, structuredSnapshot: entry.structuredSnapshot };
}

// Avoids spamming a "not ready" notification if several clicks land while
// the model is still downloading — one per tab is enough to tell the user
// what's going on.
const notReadyNotifiedTabs = new Set();

function notReadyNotificationId(tabId) {
  return `liber-not-ready-${tabId}`;
}

async function showNotReadyPrompt(tabId, status) {
  if (notReadyNotifiedTabs.has(tabId)) return;
  notReadyNotifiedTabs.add(tabId);

  const detail =
    status.state === "unsupported"
      ? "this device can't finish setting up the job tracker's automatic scraping."
      : status.state === "error"
        ? "the job tracker's setup failed partway through."
        : `the job tracker is still finishing setup${status.progress ? ` (${status.progress}%)` : ""}.`;

  await browser.notifications.create(notReadyNotificationId(tabId), {
    type: "basic",
    iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
    title: "Liber can't scrape this application yet",
    message: `Liber couldn't read this application because ${detail} Try again in a bit.`,
  });
}

// Fallback for when the result can't be delivered to the tab's own
// on-page popup (tab closed, or navigated to a page content.js never runs
// on) — a plain report, not a yes/no ask, since consent already happened
// in-page before this was ever triggered.
const OUTCOME_NOTIFICATION_TEXT = {
  saved: "Job saved. You can check it in your table.",
  duplicate: "This job's already in your tracker.",
  failed: "Couldn't save this one — try again shortly.",
};

async function showSaveResultNotification(tabId, outcome) {
  await browser.notifications.create(`liber-result-${tabId}-${Date.now()}`, {
    type: "basic",
    iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
    title: "Liber",
    message: OUTCOME_NOTIFICATION_TEXT[outcome] || OUTCOME_NOTIFICATION_TEXT.failed,
  });
}

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await browser.tabs.create({
      url: browser.runtime.getURL("src/onboarding/onboarding.html"),
    });
  }
  // No warmup() call here — onboarding.js sends LIBER_LLM_WARMUP
  // unconditionally as soon as its own page loads (covering the
  // first-install case right after the tabs.create() above). The
  // per-application flow never preloads speculatively at all now — it
  // only ever calls warmup() (via extractJobFields) once the user has
  // actually accepted a "Save this job to your tracker?" prompt.
});

// alarms, unlike setTimeout, survives MV3 service-worker suspension/restart
// — this is what actually drives the idle-unload check below. create()
// with an existing name just resets its schedule, so calling this on every
// service-worker startup (not just once-ever) is the intended pattern.
browser.alarms.create("liber-llm-idle-check", { periodInMinutes: 2 });

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "liber-llm-idle-check") return;
  if (!lastLlmActivityAt) return; // nothing loaded (or used) this service-worker lifetime
  if (Date.now() - lastLlmActivityAt < LLM_IDLE_UNLOAD_MS) return;
  await unloadEngine();
  lastLlmActivityAt = 0;
});

async function pushExtractionStatus(tabId, payload) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "LIBER_EXTRACTION_STATUS", ...payload });
    return true;
  } catch {
    return false; // no content script listening (tab closed, or a page content.js never runs on)
  }
}

// Relays live model-loading progress to whichever tab(s) are currently
// waiting on a request — background.js is already in the one context that
// reads liber_llm_status (llmEngine.js's offscreen-hosted progress
// callback writes it), so this is a plain storage.onChanged read, not a
// new broadcast mechanism. Once the model's actually ready and inference
// is running, no further status writes happen, so the "working" popup's
// bar just holds at whatever percent it reached — acceptable, inference is
// normally quick.
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "session" || !changes.liber_llm_status) return;
  if (extractingTabs.size === 0) return;
  const status = changes.liber_llm_status.newValue;
  for (const tabId of extractingTabs) {
    pushExtractionStatus(tabId, { phase: "working", progress: status?.progress || 0 });
  }
});

// LIBER_SAVE_REQUESTED handler — content.js sent this because the user
// answered "yes" to the in-page consent prompt. This is the one place
// extraction (and saving) actually happens; nothing before this point ever
// touches the model.
async function handleSaveRequested(tabId, { url, scopeText, structuredSnapshot }) {
  extractingTabs.add(tabId);
  pushExtractionStatus(tabId, { phase: "working", progress: 0 });

  let outcome;
  try {
    let merged = structuredSnapshot || { jobTitle: "", company: "", location: "" };

    if (!isComplete(merged) && scopeText) {
      let llmSnapshot;
      if (urlExtractionCache.has(url)) {
        llmSnapshot = urlExtractionCache.get(url);
      } else {
        lastLlmActivityAt = Date.now();
        llmSnapshot = await extractJobFields(scopeText);
        cacheExtraction(url, llmSnapshot);
      }
      // Structured data is free and deterministic, so a partial JSON-LD
      // read takes priority over the LLM's guess for whichever fields it
      // did find — mergeSnapshot's "more detailed wins" logic
      // (fieldMerge.js) handles the rest.
      merged = structuredSnapshot ? mergeSnapshot(structuredSnapshot, llmSnapshot).merged : llmSnapshot;
    }

    merged = normalizeSnapshot(merged);
    extractingTabs.delete(tabId);

    const savedJob = await addJob(merged); // null => duplicate, existing composite-key dedup
    outcome = savedJob ? "saved" : "duplicate";
    await appendLog({ tabId, url, step: `save requested — ${outcome}`, detail: merged });
  } catch (err) {
    extractingTabs.delete(tabId);
    if (err instanceof LlmNotReadyError) {
      await showNotReadyPrompt(tabId, err.status || (await getLlmStatus()));
    }
    await appendLog({ tabId, url, step: "save requested — failed", detail: { message: err?.message } });
    outcome = "failed";
  }

  const delivered = await pushExtractionStatus(tabId, { phase: "done", outcome });
  if (!delivered) {
    // No content script to show the result to (tab closed, or navigated to
    // a restricted page) — fall back to a plain OS notification.
    await showSaveResultNotification(tabId, outcome);
  }

  maybeUnloadEngineAfter(tabId).catch(() => {});
}

browser.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  // Deliberately not `async (message, sender) => {...}` — an async
  // function always returns a Promise, even for a message type none of
  // the branches below match. runtime.sendMessage broadcasts to every
  // listener across every extension context (including this one), so this
  // listener also receives the LIBER_OFFSCREEN_* messages llmEngine.js
  // sends to offscreen.js. If it always returned a Promise, it would race
  // offscreen.js's real (slower) response with an immediate `undefined`
  // one and usually win, silently breaking warmup()/extractJobFields() —
  // only the branches that actually handle a message return a Promise;
  // everything else falls through to an implicit, synchronous `undefined`
  // return, ceding the response to whichever listener should answer it.
  if (message.type === "LIBER_LLM_WARMUP") {
    // Sent by onboarding.js unconditionally on page load. warmup() is
    // fire-and-forget; the status is still returned synchronously in case
    // a caller wants it (onboarding.js's setup screen does).
    // Errors (e.g. no WebGPU on this device) surface through liber_llm_status,
    // which onboarding.js already watches via storage.onChanged — nothing
    // here needs to see the rejection, but it must still be caught, or an
    // LlmNotReadyError from callOffscreen becomes an unhandled rejection.
    warmup().catch(() => {});
    lastLlmActivityAt = Date.now();
    return getLlmStatus();
  }

  if (message.type === "LIBER_OFFSCREEN_STATUS") {
    // offscreen.js can't write liber_llm_status itself — Offscreen
    // Documents only expose chrome.runtime messaging, not chrome.storage
    // (confirmed directly: typeof chrome.storage is "undefined" there) —
    // so it relays every status change here instead, and this is the one
    // place that actually persists it, on its behalf.
    return setLlmStatus(message.status).then(() => {});
  }

  if (message.type === "LIBER_CONSENT_PENDING") {
    // content.js is about to show (or just showed) the consent popup —
    // record it so a redirect/new-tab before the user answers can resume it
    // on the destination page instead of losing it.
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
    // The user answered (yes or no) — nothing left to resume.
    if (tabId != null) pendingConsentByTab.delete(tabId);
    return;
  }

  if (message.type === "LIBER_CHECK_PENDING_CONSENT") {
    // Sent by every content.js instance right on load — a no-op (resolves
    // to null) on an ordinary page with nothing pending, so this costs one
    // cheap round-trip on every page load, not just application pages.
    if (tabId == null) return;
    return resolvePendingConsentFor(tabId);
  }

  if (message.type === "LIBER_LOG") {
    // Fire-and-forget mirror of content.js's console logging — persisted
    // so the dashboard's activity log can show it, independent of whether
    // anyone had that page's own devtools console open at the time.
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
    return; // fire-and-forget — the real result is delivered via LIBER_EXTRACTION_STATUS above
  }

  if (message.type === "CHECK_ONBOARDED") {
    return isOnboarded();
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  notReadyNotifiedTabs.delete(tabId);
  pendingConsentByTab.delete(tabId); // an unanswered prompt whose tab closed has nowhere left to resume
  // Nothing else to clean up — handleSaveRequested's promise chain doesn't
  // depend on the tab staying open; a mid-request tab close just means its
  // eventual pushExtractionStatus delivery fails and falls through to the
  // notification fallback above.
});
