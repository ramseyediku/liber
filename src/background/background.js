// Central coordinator: tracks a per-tab apply flow (start, refine, prompt,
// save) in browser.storage.session, and opens onboarding on first install.

import "../../vendor/browser-polyfill.js";
import { addJob, updateJob, isOnboarded } from "../shared/storage.js";
import { getFlow, setFlow, clearFlow } from "../shared/flowStorage.js";
import { mergeSnapshot } from "../shared/fieldMerge.js";
import { appendLog } from "../shared/logStorage.js";

function notificationId(tabId) {
  return `liber-confirm-${tabId}`;
}

function notificationMessage(snapshot) {
  return `${snapshot.jobTitle} at ${snapshot.company || "unknown company"}`;
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
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  const tabId = sender.tab?.id;

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
    const flow = await getFlow(tabId);

    if (!flow) {
      // Nothing tracked for this tab yet — this click starts a flow.
      // content.js no longer distinguishes "starting" from "continuing"
      // by which word was clicked (Apply vs. Next/Continue/Review); this
      // tab's actual flow state is the only reliable signal for that, so
      // the decision lives here instead.
      if (!message.snapshot) {
        // Still on a listing/search view — note a flow may be starting,
        // but there's nothing to show yet.
        await setFlow(tabId, {
          status: "pending",
          snapshot: null,
          savedJobId: null,
          dismissed: false,
          createdAt: Date.now(),
        });
        return;
      }

      await setFlow(tabId, {
        status: "captured",
        snapshot: message.snapshot,
        savedJobId: null,
        dismissed: false,
        createdAt: Date.now(),
      });
      await showSavePrompt(tabId, message.snapshot);
      return;
    }

    // A flow already exists for this tab — refine it instead of starting
    // a new one, even if this click happened to say "Apply" again (e.g.
    // a second "Easy Apply" button inside the same application).
    if (!message.snapshot) return; // listing view mid-flow — nothing to merge yet

    const { merged, conflicts } = mergeSnapshot(flow.snapshot, message.snapshot);
    if (conflicts.length) {
      console.warn(
        "Liber: field conflict on flow refine",
        conflicts,
        flow.snapshot,
        message.snapshot,
      );
    }

    if (
      flow.status === "pending" &&
      (merged.jobTitle || merged.company || merged.location)
    ) {
      // First real data for this flow — show the prompt now, even though
      // it was deferred past the original multi-job click.
      await setFlow(tabId, { ...flow, status: "captured", snapshot: merged });
      await showSavePrompt(tabId, merged);
      return;
    }

    await setFlow(tabId, { ...flow, snapshot: merged });

    if (flow.savedJobId) {
      // Already saved — update that row instead of prompting again.
      await updateJob(flow.savedJobId, merged);
    } else if (!flow.dismissed) {
      await browser.notifications
        .update(notificationId(tabId), { message: notificationMessage(merged) })
        .catch(() => {});
    }
    // If dismissed and not saved: snapshot is updated silently above, no
    // further UI action per spec.
    return;
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

browser.tabs.onRemoved.addListener((tabId) => {
  clearFlow(tabId);
});
