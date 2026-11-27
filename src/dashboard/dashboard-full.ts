// Entry point for the full-view page — table logic lives in dashboard-core.ts.
import { initDashboard } from "./dashboard-core.ts";
import { requireSetup } from "../shared/requireSetup.ts";
import { initCaptureLog } from "./captureLog.ts";
import { maybeStartTour } from "./tour.ts";

// Wire the theme toggle first so it still works if the dashboard's own
// setup throws partway through.
LiberTheme.initToggle(document.getElementById("theme-toggle"));
requireSetup().then((ready) => {
  if (!ready) return; // on its way to the welcome page
  initDashboard();
  initCaptureLog();
  maybeStartTour();
});
