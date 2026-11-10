// Create a new email/password account. Carries over whatever name/profession
// was captured anonymously on the Welcome page — signUp() replaces the
// session's user entirely, so without this the new permanent account would
// start with an empty profile.
import { getProfile, setProfile } from "../shared/storage.ts";
import { getSupabaseClient } from "../shared/supabaseClient.ts";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const form = document.getElementById("signup-form") as HTMLFormElement;
const emailInput = form.elements.namedItem("email") as HTMLInputElement;
const passwordInput = form.elements.namedItem("password") as HTMLInputElement;
const emailCheck = document.getElementById("email-check")!;
const passwordCheck = document.getElementById("password-check")!;
const emailError = document.getElementById("email-error")!;
const passwordError = document.getElementById("password-error")!;
const authError = document.getElementById("auth-error")!;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const toggleBtn = document.getElementById("toggle-password") as HTMLButtonElement;

let tried = false;

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

function syncAll(): void {
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
  if (!emailValid() || !passwordValid()) return;

  submitBtn.disabled = true;
  try {
    const existingProfile = await getProfile();

    const supabase = getSupabaseClient();
    const { error } = await supabase.auth.signUp({
      email: emailInput.value.trim(),
      password: passwordInput.value,
    });
    if (error) {
      authError.textContent = error.message;
      authError.classList.remove("hidden");
      return;
    }

    if (existingProfile) await setProfile(existingProfile);
    window.location.href = "../dashboard/dashboard-full.html";
  } finally {
    submitBtn.disabled = false;
  }
});
