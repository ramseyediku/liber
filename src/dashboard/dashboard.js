// src/dashboard/dashboard.js
// Entry point for the popup (toolbar) page. The full table/notes-popover
// logic lives in dashboard-core.js, shared with the full-view page.
// theme.js (loaded as a plain <script> in <head>, not a module — see that
// file for why) exposes its toggle wiring as window.LiberTheme.
import { initDashboard } from "./dashboard-core.js";

document.getElementById("expand-view").addEventListener("click", () => {
  browser.tabs.create({
    url: browser.runtime.getURL("src/dashboard/dashboard-full.html"),
  });
  window.close();
});

initDashboard();
LiberTheme.initToggle(document.getElementById("theme-toggle"));
