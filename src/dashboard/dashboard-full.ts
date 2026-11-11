// Entry point for the full-view page — table logic lives in dashboard-core.ts.
import { initDashboard } from "./dashboard-core.ts";
import { maybeStartTour } from "./tour.ts";

// Wire the theme toggle first so it still works if the dashboard's own
// setup throws partway through.
LiberTheme.initToggle(document.getElementById("theme-toggle"));
initDashboard();
maybeStartTour();
