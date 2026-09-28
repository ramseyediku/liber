// src/onboarding/onboarding.js
// Handles the first-run (and settings-page) profile form: saves name +
// profession via the shared storage module and swaps in the confirmation
// message.

import { getProfile, setProfile } from "../shared/storage.js";

const form = document.getElementById("onboarding-form");
const confirmation = document.getElementById("confirmation");

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
  confirmation.classList.remove("hidden");
});

prefillIfOnboarded();
