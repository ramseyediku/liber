// src/dashboard/dashboard-full.js
// Entry point for the full-view page (opened in its own tab from the
// popup). The full table/notes-popover logic lives in dashboard-core.js,
// shared with the popup page.
// theme.js (loaded as a plain <script> in <head>, not a module — see that
// file for why) exposes its toggle wiring as window.LiberTheme.
import { initDashboard } from "./dashboard-core.js";

initDashboard();
LiberTheme.initToggle(document.getElementById("theme-toggle"));
