// First-run profile form: saves name + profession, then shows the confirmation message.
import { getProfile, setProfile } from "../shared/storage.js";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const form = document.getElementById("onboarding-form");
const confirmation = document.getElementById("confirmation");
const slogan = document.querySelector("p");

async function prefillIfOnboarded() {
  const profile = await getProfile();
  if (!profile) return;
  form.elements.name.value = profile.name || "";
  form.elements.profession.value = profile.profession || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = form.elements.name.value.trim();
  const profession = form.elements.profession.value.trim();
  if (!name || !profession) return;

  await setProfile({ name, profession });

  form.classList.add("hidden");
  slogan.classList.add("hidden");
  confirmation.classList.remove("hidden");
});

prefillIfOnboarded();
