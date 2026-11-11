// First-run page: your name (becomes the display name, changeable later in
// Settings) and an optional role, no account needed. The role becomes the
// first job profile (storage.ts's renameActiveJobProfile). People who already
// have an account can log in from here instead.
import {
  getProfile,
  markOnboarded,
  renameActiveJobProfile,
  setProfile,
} from "../shared/storage.ts";
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
  if (profile?.name) nameInput.value = profile.name;
  if (profile?.profession) professionInput.value = profile.profession;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = nameInput.value.trim();
  const profession = toTitleCase(professionInput.value.trim());
  if (!name) return;

  submitBtn.disabled = true;
  try {
    const profile = await getProfile();
    await setProfile({ name, profession: profession || profile?.profession || "" });
    if (profession) await renameActiveJobProfile(profession);
    await markOnboarded();
    // ?tour=1 tells the dashboard to run the first-run tour once — see
    // dashboard-full.ts.
    window.location.href = "../dashboard/dashboard-full.html?tour=1";
  } finally {
    submitBtn.disabled = false;
  }
});

ensureSession().then(prefillIfOnboarded);
