// First-run tour, shown once right after Welcome (onboarding.ts) redirects
// here with ?tour=1. Walks the whole dashboard: the page as a whole, the job
// profile switcher, the table, the status pills, search, then Settings.
import { driver, type DriveStep } from "driver.js";
import { isPermanentUser } from "../shared/supabaseClient.ts";

const TOUR_PARAM = "tour";

export async function maybeStartTour(): Promise<void> {
  const url = new URL(window.location.href);
  if (url.searchParams.get(TOUR_PARAM) !== "1") return;

  // Runs once per redirect from Welcome — strip the param so a reload or
  // bookmark of this URL doesn't replay it.
  url.searchParams.delete(TOUR_PARAM);
  window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);

  // Guests only: a logged-in account has no Log in button to point at.
  const guestSteps: DriveStep[] = (await isPermanentUser().catch(() => false))
    ? []
    : [
        {
          element: "#login-link",
          popover: {
            title: "You're using a guest account",
            description:
              "Your applications stay private on this device. Log in or create an account to turn on cloud sync and see them anywhere.",
            side: "bottom",
            align: "end",
          },
        },
      ];

  driver({
    showProgress: true,
    overlayOpacity: 0.5,
    stageRadius: 12,
    popoverClass: "liber-tour-popover",
    steps: [
      {
        // No element: a centred card describing the page as a whole.
        popover: {
          title: "Welcome to your dashboard",
          description:
            "This is where every job you apply to is kept. Liber notices when you apply on a job site and offers to save it here, so you never have to type it in. Let's take a quick look around.",
          showButtons: ["next", "close"],
        },
      },
      ...guestSteps,
      {
        element: "#profile-switcher",
        popover: {
          title: "Your job profiles",
          description:
            "Applications are grouped by job profile, such as the role you're after. Click this to switch between your profiles or, with Premium, add another one.",
          side: "bottom",
          align: "start",
        },
      },
      {
        element: "#jobs-table-wrap",
        popover: {
          title: "Your applications",
          description:
            "Every job you save shows up here, with the company, job title, location and the date you added it. Click a row to open the full record, and add notes to remember the details.",
          side: "top",
          align: "center",
        },
      },
      {
        element: "#status-filters",
        popover: {
          title: "Status pills",
          description:
            "Each pill shows how many applications sit in that status. Click one to filter the table, and click it again to clear. You change a job's status from the coloured pill on its row as you hear back.",
          side: "bottom",
          align: "start",
        },
      },
      {
        element: ".dashboard__search",
        popover: {
          title: "Search",
          description:
            "Find an application fast by company, job title or your notes.",
          side: "bottom",
          align: "end",
        },
      },
      {
        element: '.dashboard__aside a[aria-label="Settings"]',
        popover: {
          title: "Settings",
          description:
            "Change your display name, manage job profiles, turn on cloud sync, export your data and see your plan.",
          side: "right",
          align: "start",
        },
      },
    ],
  }).drive();
}
