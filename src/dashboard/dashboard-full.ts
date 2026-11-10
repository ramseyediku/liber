// Entry point for the full-view page — table logic lives in dashboard-core.ts.
import { initDashboard } from "./dashboard-core.ts";
import { maybeStartTour } from "./tour.ts";

initDashboard();
LiberTheme.initToggle(document.getElementById("theme-toggle"));
maybeStartTour();
