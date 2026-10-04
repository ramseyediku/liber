// Entry point for the popup page — table logic lives in dashboard-core.js.
import { initDashboard } from "./dashboard-core.js";

document.getElementById("expand-view").addEventListener("click", () => {
  browser.tabs.create({
    url: browser.runtime.getURL("src/dashboard/dashboard-full.html"),
  });
  window.close();
});

initDashboard({ cardMode: true, cardLimit: 5 });
LiberTheme.initToggle(document.getElementById("theme-toggle"));
