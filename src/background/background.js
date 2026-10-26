// Central coordinator: tracks a per-tab apply flow (pending, captured,
// saved) in browser.storage.session, and opens onboarding on first install.
// Also hosts the on-device LLM engine (src/shared/llmEngine.js) that turns
// a flow step's raw scope text into {jobTitle, company, location} — the
// only context any of this runs in, see llmEngine.js's header for why.
//
// content.js no longer blocks or scopes anything at click time — it fires
// an immediate, empty-scopeText LIBER_FLOW_STEP the instant a trigger is
// clicked (purely to create/touch this tab's flow — see handleFlowStep's
// "no snapshot" branches), then separately sends a real scopeText once a
// modal appears or the page settles. That arming message is what lets this
// file's tabs.onUpdated listener recognize a tab as "mid-flow" even after a
// real navigation destroys the content script that armed it, or a click
// opens a brand-new tab whose own content script has no idea a click
// happened — see that listener below for the other half of this.

import "../../vendor/browser-polyfill.js";
import {
  addJob,
  updateJob,
  isOnboarded,
  hasNotifiedLlmReady,
  markLlmReadyNotified,
} from "../shared/storage.js";
import { getFlow, setFlow, clearFlow, copyFlow } from "../shared/flowStorage.js";
import { mergeSnapshot } from "../shared/fieldMerge.js";
import { appendLog } from "../shared/logStorage.js";
import { warmup, extractJobFields, LlmNotReadyError } from "../shared/llmEngine.js";
import { getLlmStatus } from "../shared/llmStatus.js";

// A flow is only ever worth cross-navigation/cross-tab scanning while it's
// genuinely active — this bounds how long after the last real activity a
// tabs.onUpdated load-complete is still treated as "part of that flow",
// rather than, say, the user closing the application tab and browsing
// elsewhere in a tab that happens to share an opener from hours ago.
const RECENT_FLOW_WINDOW_MS = 2 * 60 * 1000;

function isComplete(snapshot) {
  return !!(snapshot && snapshot.jobTitle && snapshot.company && snapshot.location);
}

// Avoids spamming a "not ready" notification on every single click while a
// multi-step apply flow is in progress and the model is still downloading —
// one per tab is enough to tell the user what's going on.
const notReadyNotifiedTabs = new Set();

function notReadyNotificationId(tabId) {
  return `liber-not-ready-${tabId}`;
}

async function showNotReadyPrompt(tabId, status) {
  if (notReadyNotifiedTabs.has(tabId)) return;
  notReadyNotifiedTabs.add(tabId);

  const detail =
    status.state === "unsupported"
      ? "your browser/device doesn't support the on-device model (WebGPU required)."
      : status.state === "error"
        ? `the on-device model failed to load (${status.message || "unknown error"}).`
        : `the on-device model is still loading${status.progress ? ` (${status.progress}%)` : ""}.`;

  await browser.notifications.create(notReadyNotificationId(tabId), {
    type: "basic",
    iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
    title: "Liber can't scrape this application yet",
    message: `Liber couldn't read this application because ${detail} Try again in a bit.`,
  });
}

// A load's eventual success never triggers more than one of these, even
// though warmup() is reached from several places below (onInstalled,
// onStartup, LIBER_LLM_WARMUP) and may already be in flight/settled by the
// time any one of them runs — see warmupAndNotify().
let readyNotificationAttached = false;

async function notifyWhenReady(enginePromise) {
  if (readyNotificationAttached) return;
  readyNotificationAttached = true;

  enginePromise
    .then(async () => {
      // The persistent (storage.local, not session) flag is what actually
      // makes this "once ever," not just "once per service-worker
      // lifetime" — a cache-warm reload after a later SW restart also
      // resolves this same promise, and shouldn't re-notify.
      if (await hasNotifiedLlmReady()) return;
      await markLlmReadyNotified();
      await browser.notifications.create("liber-llm-ready", {
        type: "basic",
        iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
        title: "Liber's on-device AI is ready",
        message:
          "The one-time setup download is done — click Apply on any job posting and Liber will scrape it automatically from now on.",
      });
    })
    .catch(() => {}); // a failed load has nothing to notify about here
}

// Every onInstalled/onStartup/LIBER_LLM_WARMUP call site uses this instead
// of calling llmEngine's warmup() directly, so the "ready" notification
// above gets attached exactly once rather than duplicated across whichever
// of those happens to fire first.
function warmupAndNotify() {
  const promise = warmup();
  notifyWhenReady(promise);
  return promise;
}

function notificationId(tabId) {
  return `liber-confirm-${tabId}`;
}

function notificationMessage(snapshot) {
  return `${snapshot.jobTitle || "Unknown role"} at ${snapshot.company || "unknown company"}`;
}

async function showSavePrompt(tabId, snapshot) {
  await browser.notifications.create(notificationId(tabId), {
    type: "basic",
    iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
    title: "Save this job application?",
    message: notificationMessage(snapshot),
    buttons: [{ title: "Save to Liber" }, { title: "Dismiss" }],
    requireInteraction: true,
  });
}

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await browser.tabs.create({
      url: browser.runtime.getURL("src/onboarding/onboarding.html"),
    });
  }
  warmupAndNotify(); // fire-and-forget — starts the model download/load immediately
});

// Covers the "already installed, just reopened the browser" case —
// onInstalled above only fires on install/update, not every browser start,
// and a service worker's module scope (and so llmEngine's singleton
// promise) doesn't survive a full browser restart.
browser.runtime.onStartup.addListener(() => {
  warmupAndNotify();
});

// The single funnel point for every LIBER_FLOW_STEP, whichever of three
// places it came from: content.js's click-time arming/scan messages
// (onMessage below), or background.js's own cross-navigation/cross-tab
// scans (the tabs.onUpdated listener further down). scopeText is raw
// bounded page text, not a ready-made snapshot — extraction happens here,
// since this is the one context the LLM engine actually lives in (see
// llmEngine.js's header).
async function handleFlowStep(tabId, scopeText) {
  // Empty scope text (content.js's arming message, or a genuine "nothing
  // found nearby") is a real "falsy snapshot" signal distinct from "model
  // not ready" — handled before touching the engine at all.
  let snapshot = null;
  if (scopeText) {
    try {
      snapshot = await extractJobFields(scopeText);
    } catch (err) {
      if (err instanceof LlmNotReadyError) {
        await showNotReadyPrompt(tabId, err.status || (await getLlmStatus()));
        return;
      }
      throw err;
    }
  }

  const flow = await getFlow(tabId);

  if (!flow) {
    // Nothing tracked for this tab yet — this is what starts a flow
    // (typically the click-time arming message, which always has no
    // snapshot). content.js no longer distinguishes "starting" from
    // "continuing" by which word was clicked; this tab's actual flow state
    // is the only reliable signal for that, so the decision lives here.
    if (!isComplete(snapshot)) {
      // Still missing at least one field (most commonly: nothing at all
      // yet) — note a flow may be starting, but there's nothing to prompt
      // on yet. A snapshot with some, but not all, fields is still stored
      // so later refinements have something to merge into.
      await setFlow(tabId, {
        status: "pending",
        snapshot,
        savedJobId: null,
        dismissed: false,
        createdAt: Date.now(),
      });
      return;
    }

    await setFlow(tabId, {
      status: "captured",
      snapshot,
      savedJobId: null,
      dismissed: false,
      createdAt: Date.now(),
    });
    await showSavePrompt(tabId, snapshot);
    return;
  }

  // A flow already exists for this tab — refine it instead of starting a
  // new one, even if this click happened to say "Apply" again (e.g. a
  // second "Easy Apply" button inside the same application).
  if (!snapshot) {
    // Nothing new to merge — still touch the flow so its lastUpdatedAt
    // reflects this activity. Matters for the arming message in
    // particular: without this, an arming-only click on an already-started
    // flow would never refresh the timestamp the tabs.onUpdated listener
    // below uses to decide whether a flow is still "recent enough" to be
    // worth scanning.
    await setFlow(tabId, flow);
    return;
  }

  const { merged, conflicts } = mergeSnapshot(flow.snapshot, snapshot);
  if (conflicts.length) {
    console.warn(
      "Liber: field conflict on flow refine",
      conflicts,
      flow.snapshot,
      snapshot,
    );
  }

  if (flow.status === "pending" && isComplete(merged)) {
    // All three fields are now known — show the prompt now, at the end of
    // the flow, rather than as soon as the first field was found.
    await setFlow(tabId, { ...flow, status: "captured", snapshot: merged });
    await showSavePrompt(tabId, merged);
    return;
  }

  await setFlow(tabId, { ...flow, snapshot: merged });

  if (flow.savedJobId) {
    // Already saved — update that row instead of prompting again.
    await updateJob(flow.savedJobId, merged);
  } else if (flow.status === "captured" && !flow.dismissed) {
    await browser.notifications
      .update(notificationId(tabId), { message: notificationMessage(merged) })
      .catch(() => {});
  }
  // If still pending (fields incomplete) or dismissed and not saved:
  // snapshot is updated silently above, no further UI action.
}

// Self-contained — chrome.scripting.executeScript's injected `func` can't
// import a module, so this intentionally duplicates a small slice of
// content.js's findVisibleDialog/resolvePageScope. Deliberately narrower
// than that version: no overlay-heuristic fallback, no
// countVisibleJobTitles, no MutationObserver/settle-window, since a one-shot
// scan right after the tab's "complete" status already waited for the page
// to load. If you change the scope-resolution logic here, check whether
// content.js's copy needs the same change, and vice versa.
function liberScanInjectedPage() {
  function isVisible(el) {
    if (!el.offsetParent) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function findVisibleDialog() {
    return (
      Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog')).find(
        isVisible,
      ) || null
    );
  }
  const scope =
    findVisibleDialog() ||
    document.querySelector('form, main, [role="main"], article') ||
    document.body;
  const text = (scope.innerText || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  return { text, url: location.href };
}

// Covers the two cases content.js's own in-page observer structurally
// cannot: a real same-tab page navigation (content.js's instance on the
// pre-navigation page is gone by the time the new page loads) and a
// brand-new tab (whose content.js has no idea a click happened anywhere).
// Both are driven off the same signal: a tab recently armed/updated by
// handleFlowStep (see content.js's header for why the arming message
// exists). tab.openerTabId being available right here is what lets one
// listener cover both — no separate tabs.onCreated listener/race needed.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  let flow = await getFlow(tabId);

  // Brand-new tab opened from a tab with a recent flow (e.g. an ATS
  // redirect to a separate company/Greenhouse/Lever domain) — inherit it.
  if (!flow && tab.openerTabId != null) {
    const openerFlow = await getFlow(tab.openerTabId);
    if (openerFlow && Date.now() - openerFlow.lastUpdatedAt <= RECENT_FLOW_WINDOW_MS) {
      flow = await copyFlow(tab.openerTabId, tabId);
      await appendLog({
        tabId,
        url: tab.url,
        step: "flow linked from opener tab",
        detail: { openerTabId: tab.openerTabId },
      });
    }
  }

  if (!flow) return;
  if (Date.now() - flow.lastUpdatedAt > RECENT_FLOW_WINDOW_MS) return; // stale — user wandered off
  if (flow.lastScannedUrl === tab.url) return; // already scanned this exact page

  let scanResult;
  try {
    const [{ result }] = await browser.scripting.executeScript({
      target: { tabId },
      func: liberScanInjectedPage,
    });
    scanResult = result;
  } catch {
    return; // restricted page (chrome://, store, pdf viewer, etc.)
  }

  await setFlow(tabId, { ...flow, lastScannedUrl: tab.url });
  await appendLog({
    tabId,
    url: tab.url,
    step: "cross-navigation scan",
    detail: { textLength: scanResult?.text?.length ?? 0 },
  });
  await handleFlowStep(tabId, scanResult?.text || "");
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  const tabId = sender.tab?.id;

  if (message.type === "LIBER_LLM_WARMUP") {
    warmupAndNotify(); // fire-and-forget, sent by onboarding.js/dashboard-core.js
    return;
  }

  if (message.type === "LIBER_LOG") {
    // Fire-and-forget mirror of content.js's console logging — persisted
    // so the dashboard's activity log can show it, independent of whether
    // anyone had that page's own devtools console open at the time.
    await appendLog({
      tabId: tabId ?? null,
      url: message.url,
      step: message.step,
      detail: message.detail ?? null,
    });
    return;
  }

  if (message.type === "LIBER_FLOW_STEP") {
    if (tabId == null) return;
    return handleFlowStep(tabId, message.scopeText);
  }

  if (message.type === "CHECK_ONBOARDED") {
    return isOnboarded();
  }
});

browser.notifications.onButtonClicked.addListener(
  async (notifId, buttonIndex) => {
    if (!notifId.startsWith("liber-confirm-")) return;
    const tabId = Number(notifId.replace("liber-confirm-", ""));
    const flow = await getFlow(tabId);
    if (!flow) return;

    if (buttonIndex === 0) {
      // "Save to Liber" — keep the flow around (don't clear it) so later
      // refinements can update this saved row instead of re-prompting.
      const savedJob = await addJob(flow.snapshot);
      await setFlow(tabId, { ...flow, savedJobId: savedJob?.id ?? null });
    } else {
      // "Dismiss" — keep the flow around too; later refinements still
      // update the stored snapshot, just without showing the prompt again.
      await setFlow(tabId, { ...flow, dismissed: true });
    }

    browser.notifications.clear(notifId);
  },
);

browser.tabs.onRemoved.addListener(async (tabId) => {
  notReadyNotifiedTabs.delete(tabId);

  const flow = await getFlow(tabId);
  const snapshot = flow?.snapshot;
  const hasSomeData = !!(snapshot?.jobTitle || snapshot?.company || snapshot?.location);

  if (flow && flow.status === "pending" && !flow.dismissed && hasSomeData) {
    // The tab closed before all three fields were ever found (e.g. a site
    // that never exposes location) — rather than silently losing a real
    // application over one missing field, fall back to the old "prompt on
    // any field" behavior as a last resort, once, here. Don't clear the
    // flow: the notification button handler still needs getFlow(tabId) to
    // work, and the existing 30-min TTL cleans this up if the notification
    // is never clicked. (A flow that goes stale via that TTL *while its
    // tab stays open* gets no such fallback — MV3 has no persistent timer
    // to drive that proactively; accepted, scoped to the tab-close moment,
    // which is the common, concrete "this flow is really over" signal.)
    await setFlow(tabId, { ...flow, status: "captured" });
    await showSavePrompt(tabId, snapshot);
    return;
  }

  await clearFlow(tabId);
});
