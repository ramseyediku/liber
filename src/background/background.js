// Central coordinator: receives scrape events, prompts for confirmation,
// saves confirmed jobs, and opens onboarding on first install.

import "../../vendor/browser-polyfill.js";
import { addJob, isOnboarded } from "../shared/storage.js";

// Most recent scrape per tab, acted on once the user responds to the notification.
const pendingByTab = new Map();

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await browser.tabs.create({
      url: browser.runtime.getURL("src/onboarding/onboarding.html"),
    });
  }
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if (message.type === "JOB_APPLY_DETECTED") {
    const tabId = sender.tab?.id;
    if (tabId == null) return;

    pendingByTab.set(tabId, message.payload);

    // v1: a browser notification; clicking it triggers the save.
    await browser.notifications.create(`liber-confirm-${tabId}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("src/assets/icons/icon128.png"),
      title: "Save this job application?",
      message: `${message.payload.jobTitle} at ${message.payload.company || "unknown company"}`,
      buttons: [{ title: "Save to Liber" }, { title: "Dismiss" }],
      requireInteraction: true,
    });
  }

  if (message.type === "CHECK_ONBOARDED") {
    return isOnboarded();
  }
});

browser.notifications.onButtonClicked.addListener(
  async (notificationId, buttonIndex) => {
    if (!notificationId.startsWith("liber-confirm-")) return;
    const tabId = Number(notificationId.replace("liber-confirm-", ""));
    const payload = pendingByTab.get(tabId);
    if (!payload) return;

    if (buttonIndex === 0) {
      // "Save to Liber"
      await addJob(payload);
    }

    pendingByTab.delete(tabId);
    browser.notifications.clear(notificationId);
  },
);
