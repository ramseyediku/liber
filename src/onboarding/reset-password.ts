// Requests a password-reset email. Supabase always reports success here
// regardless of whether the address has an account (avoids leaking which
// emails are registered) — the "If there's a Liber account for…" wording
// in the sent state reflects that.
import { getSupabaseClient } from "../shared/supabaseClient.ts";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requestState = document.getElementById("request-state")!;
const sentState = document.getElementById("sent-state")!;
const form = document.getElementById("reset-form") as HTMLFormElement;
const emailInput = form.elements.namedItem("email") as HTMLInputElement;
const emailCheck = document.getElementById("email-check")!;
const emailError = document.getElementById("email-error")!;
const authError = document.getElementById("auth-error")!;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const sentEmail = document.getElementById("sent-email")!;

let tried = false;

function emailValid(): boolean {
  return EMAIL_RE.test(emailInput.value.trim());
}

function syncField(): void {
  const valid = emailValid();
  emailCheck.classList.toggle("hidden", !valid);
  emailInput.toggleAttribute("data-valid", valid);
  const showError = tried && !valid;
  emailInput.setAttribute("aria-invalid", showError ? "true" : "false");
  emailError.querySelector("span")!.textContent = emailInput.value.trim()
    ? "Enter an email address like name@example.com"
    : "Enter your email address";
  emailError.classList.toggle("hidden", !showError);
}

emailInput.addEventListener("input", syncField);

async function sendResetLink(): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(emailInput.value.trim());
  if (error) {
    authError.textContent = error.message;
    authError.classList.remove("hidden");
    return;
  }
  sentEmail.textContent = emailInput.value.trim();
  requestState.classList.add("hidden");
  sentState.classList.remove("hidden");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  tried = true;
  authError.classList.add("hidden");
  syncField();
  if (!emailValid()) return;

  submitBtn.disabled = true;
  try {
    await sendResetLink();
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById("back-to-login-btn")!.addEventListener("click", () => {
  window.location.href = "login.html";
});

document.getElementById("resend-btn")!.addEventListener("click", () => {
  sendResetLink();
});

document.getElementById("use-other-btn")!.addEventListener("click", () => {
  sentState.classList.add("hidden");
  requestState.classList.remove("hidden");
});
