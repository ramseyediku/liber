// First-run page: name/profession only, no auth (storage.ts's setProfile —
// stored in the current session's user_metadata, anonymous or not). Signing
// in/up now lives on their own pages — see login.ts/signup.ts.
import { getProfile, setProfile } from "../shared/storage.ts";
import { ensureSession } from "../shared/supabaseClient.ts";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const form = document.getElementById("onboarding-form") as HTMLFormElement;
const nameInput = form.elements.namedItem("name") as HTMLInputElement;
const professionInput = form.elements.namedItem("profession") as HTMLInputElement;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;

function toTitleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function prefillIfOnboarded(): Promise<void> {
  const profile = await getProfile();
  if (!profile) return;
  nameInput.value = profile.name || "";
  professionInput.value = profile.profession || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  const profession = toTitleCase(professionInput.value.trim());
  if (!name || !profession) return;

  submitBtn.disabled = true;
  try {
    await setProfile({ name, profession });
    // ?tour=1 tells the dashboard to run the first-run tour once — see
    // dashboard-full.ts.
    window.location.href = "../dashboard/dashboard-full.html?tour=1";
  } finally {
    submitBtn.disabled = false;
  }
});

ensureSession().then(prefillIfOnboarded);
