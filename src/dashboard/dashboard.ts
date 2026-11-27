// Entry point for the popup page — table logic lives in dashboard-core.ts.
import { initDashboard } from "./dashboard-core.ts";
import { requireSetup } from "../shared/requireSetup.ts";

document.getElementById("expand-view")!.addEventListener("click", () => {
  browser.tabs.create({
    url: browser.runtime.getURL("src/dashboard/dashboard-full.html"),
  });
  window.close();
});

requireSetup({ popup: true }).then((ready) => {
  if (ready) initDashboard({ cardMode: true, cardLimit: 4 });
});
