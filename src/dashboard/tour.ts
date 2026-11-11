// First-run tour, shown once right after Welcome (onboarding.ts) redirects
// here with ?tour=1. Steps, anchors, and copy are taken from the design
// mockup's dashboard tour (Liber.html — see the memory/project notes on
// the v2 redesign). One exception: the mockup's step 1 points at a
// job-title switcher chip that doesn't exist yet (multi-job-title support
// was explicitly deferred), so that step's copy drops the "click it to
// switch" sentence and anchors to the static profession pill instead.
import { driver } from "driver.js";

const TOUR_PARAM = "tour";

export function maybeStartTour(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get(TOUR_PARAM) !== "1") return;

  // Runs once per redirect from Welcome — strip the param so a reload or
  // bookmark of this URL doesn't replay it.
  url.searchParams.delete(TOUR_PARAM);
  window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);

  driver({
    showProgress: true,
    overlayOpacity: 0.5,
    stageRadius: 12,
    popoverClass: "liber-tour-popover",
    steps: [
      {
        element: ".dashboard__profession-pill",
        popover: {
          title: "The job you're applying for",
          description: "This is the role you're applying for — Liber tracks your applications under it.",
          side: "bottom",
          align: "start",
          showButtons: ["next", "close"],
        },
      },
      {
        element: "#jobs-table-wrap",
        popover: {
          title: "Your applications",
          description:
            "Every job you save shows up here, with the company, job title, location and the date you added it. Update the status as you hear back, and add notes to remember the details.",
          side: "bottom",
          align: "center",
        },
      },
    ],
  }).drive();
}
