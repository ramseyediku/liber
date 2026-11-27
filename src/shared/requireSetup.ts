// App pages (dashboard, popup, settings) are only for someone who has finished
// the welcome page. No display name = not set up (a fresh guest, or right after
// logging out), so send them to the welcome page instead of an empty dashboard.
import { hasDisplayName } from "./storage.ts";

const WELCOME_PATH = "src/onboarding/onboarding.html";

export async function requireSetup(options: { popup?: boolean } = {}): Promise<boolean> {
  if (await hasDisplayName().catch(() => true)) return true; // can't tell: don't lock anyone out
  const url = browser.runtime.getURL(WELCOME_PATH);
  if (options.popup) {
    // The toolbar popup can't show the welcome page itself: open it in a tab.
    await browser.tabs.create({ url });
    window.close();
  } else {
    window.location.replace(url);
  }
  return false;
}

// Log out, then start over at the welcome page.
export function welcomeUrl(): string {
  return browser.runtime.getURL(WELCOME_PATH);
}
