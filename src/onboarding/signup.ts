// Create an email/password account. The display name is collected here
// (changeable later in Settings). On a device already running as a guest
// (anonymous session) the guest is upgraded in place with updateUser() —
// same user id, so its applications and job profiles carry over and no
// orphaned guest account is left behind. signUp() (a brand-new user) is only
// the fallback when there is no guest session.
import {
  ensureActiveJobProfileExists,
  getProfile,
  markOnboarded,
  setProfile,
} from "../shared/storage.ts";
import { ensureSession, getSupabaseClient } from "../shared/supabaseClient.ts";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const form = document.getElementById("signup-form") as HTMLFormElement;
const emailInput = form.elements.namedItem("email") as HTMLInputElement;
const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
const nameInput = form.elements.namedItem("name") as HTMLInputElement;
const nameError = document.getElementById("name-error")!;
const emailCheck = document.getElementById("email-check")!;
const passwordCheck = document.getElementById("password-check")!;
const emailError = document.getElementById("email-error")!;
const passwordError = document.getElementById("password-error")!;
const authError = document.getElementById("auth-error")!;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const toggleBtn = document.getElementById("toggle-password") as HTMLButtonElement;

let tried = false;

// A name already given on the Welcome page is prefilled (still editable).
getProfile()
  .then((existing) => {
    if (existing?.name && !nameInput.value) nameInput.value = existing.name;
  })
  .catch(() => {});

function syncField(input: HTMLInputElement, check: HTMLElement, error: HTMLElement, valid: boolean): void {
  check.classList.toggle("hidden", !valid);
  input.toggleAttribute("data-valid", valid);
  const showError = tried && !valid;
  input.setAttribute("aria-invalid", showError ? "true" : "false");
  error.classList.toggle("hidden", !showError);
}

function emailValid(): boolean {
  return EMAIL_RE.test(emailInput.value.trim());
}

function passwordValid(): boolean {
  return passwordInput.value.length >= 8;
}

function nameValid(): boolean {
  return nameInput.value.trim().length > 0;
}

function syncAll(): void {
  nameInput.setAttribute("aria-invalid", tried && !nameValid() ? "true" : "false");
  nameError.classList.toggle("hidden", !(tried && !nameValid()));
  syncField(emailInput, emailCheck, emailError, emailValid());
  emailError.querySelector("span")!.textContent = emailInput.value.trim()
    ? "Enter an email address like name@example.com"
    : "Enter your email address";
  syncField(passwordInput, passwordCheck, passwordError, passwordValid());
  passwordError.querySelector("span")!.textContent = passwordInput.value
    ? "Password must be at least 8 characters"
    : "Enter a password";
}

emailInput.addEventListener("input", syncAll);
passwordInput.addEventListener("input", syncAll);
nameInput.addEventListener("input", syncAll);

toggleBtn.addEventListener("click", () => {
  const show = passwordInput.type === "password";
  passwordInput.type = show ? "text" : "password";
  toggleBtn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  toggleBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><use href="../shared/icons.svg#${show ? "icon-eye-off" : "icon-eye"}"></use></svg>`;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  tried = true;
  authError.classList.add("hidden");
  syncAll();
  if (!nameValid() || !emailValid() || !passwordValid()) return;

  submitBtn.disabled = true;
  try {
    const existingProfile = await getProfile();

    await ensureSession();
    const supabase = getSupabaseClient();
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    const { data: current } = await supabase.auth.getUser();
    if (current?.user?.is_anonymous) {
      const { data, error } = await supabase.auth.updateUser({ email, password });
      if (error) {
        authError.textContent = error.message;
        authError.classList.remove("hidden");
        return;
      }
      // With email confirmation on, the guest only becomes a full account
      // once the emailed link is opened — don't pretend it's done yet.
      if (data.user?.is_anonymous) {
        await setProfile({
          name: nameInput.value.trim(),
          profession: existingProfile?.profession ?? "",
        });
        await ensureActiveJobProfileExists().catch(() => {});
        authError.textContent = "Check your email and open the link to finish creating your account.";
        authError.classList.remove("hidden");
        return;
      }
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) {
        authError.textContent = error.message;
        authError.classList.remove("hidden");
        return;
      }
    }

    await setProfile({
      name: nameInput.value.trim(),
      profession: existingProfile?.profession ?? "",
    });
    await markOnboarded();
    // The new account starts with its default job profile (the role from
    // setup, or "General") as a real profile, so it shows under Settings →
    // Job profiles. Best effort: the first saved job creates it anyway.
    await ensureActiveJobProfileExists().catch(() => {});
    window.location.href = "../dashboard/dashboard-full.html";
  } finally {
    submitBtn.disabled = false;
  }
});
