// First-run profile form: saves name + profession, then shows a
// post-submit setup screen reflecting the background model load's status
// (src/shared/llmStatus.js) — worded with no AI/model/WebGPU mentions on
// purpose.
import { getProfile, setProfile } from "../shared/storage.js";
import { getLlmStatus } from "../shared/llmStatus.js";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

// Kick off the (lazily-memoized, see llmEngine.js's warmup()) background
// load as soon as this page's script runs — not gated on submit — so the
// one-time download/load has a head start by the time most users finish
// filling out the form. Silent: the setup screen below only becomes
// visible after submit. Fire-and-forget and independent of this tab's
// lifetime — warmup()'s enginePromise lives in the background service
// worker's own module scope, so closing this tab never cancels it.
browser.runtime.sendMessage({ type: "LIBER_LLM_WARMUP" }).catch(() => {});

const form = document.getElementById("onboarding-form");
const confirmation = document.getElementById("confirmation");
const slogan = document.querySelector("p");

// "error" has no element of its own — it renders inside the same
// #setup-loading block as "loading" (so the progress bar visibly turns
// red in place instead of being swapped out for a separate block). See
// renderSetupState's isError handling below.
const setupStates = {
  loading: document.getElementById("setup-loading"),
  ready: document.getElementById("setup-ready"),
  unsupported: document.getElementById("setup-unsupported"),
};
const setupProgress = document.getElementById("setup-progress");
const progressFill = document.getElementById("setup-progress-fill");
const statusText = document.getElementById("setup-status-text");
const retryBtn = document.getElementById("setup-retry-btn");

// Drives the setup screen from the same liber_llm_status record the
// dashboard's (now-removed) status chip used to mirror. "idle"/unknown
// falls back to the loading view — covers the brief window right after
// submit before the first real "loading" status write lands.
function renderSetupState(status) {
  const state = status?.state || "idle";
  const isError = state === "error";
  const visible = isError ? "loading" : setupStates[state] ? state : "loading";

  Object.entries(setupStates).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== visible);
  });
  setupProgress.classList.toggle("setup-progress--error", isError);
  retryBtn.classList.toggle("hidden", !isError);

  if (visible === "loading") {
    const progress = status?.progress || 0;
    progressFill.style.width = `${progress}%`;

    if (isError) {
      // Deliberately a fixed message, not status.message — that field can
      // carry llmEngine.js's internal error text, which isn't guaranteed
      // free of AI/model wording. A fixed string guarantees the rule holds.
      statusText.textContent =
        "Something went wrong while setting up your job tracker. You can try again, or close this tab for now — Liber will still let you track applications manually in the meantime.";
    } else {
      statusText.textContent = progress >= 90 ? "Almost ready…" : "Downloading…";
    }
  }
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.liber_llm_status) {
    renderSetupState(changes.liber_llm_status.newValue);
  }
});

document.getElementById("setup-retry-btn").addEventListener("click", () => {
  // warmup() clears its cached promise and retries fresh specifically on
  // "error" status (see llmEngine.js) — re-sending the trigger is enough;
  // the "loading" push that follows updates this view automatically.
  browser.runtime.sendMessage({ type: "LIBER_LLM_WARMUP" }).catch(() => {});
});

function closeThisTab() {
  // This tab was opened via browser.tabs.create() from the extension
  // itself (background.js's onInstalled) — exactly the case window.close()
  // is allowed to self-close under browser security models. There's no
  // existing tab-closing pattern elsewhere in this codebase to reuse.
  window.close();
}
document.getElementById("setup-ok-btn").addEventListener("click", closeThisTab);
document.getElementById("setup-dismiss-btn").addEventListener("click", closeThisTab);

function toTitleCase(text) {
  return text
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function prefillIfOnboarded() {
  const profile = await getProfile();
  if (!profile) return;
  form.elements.name.value = profile.name || "";
  form.elements.profession.value = profile.profession || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = form.elements.name.value.trim();
  const profession = toTitleCase(form.elements.profession.value.trim());
  if (!name || !profession) return;

  await setProfile({ name, profession });

  // Skip the wait entirely if the load already finished (fast connection,
  // or this page reused later as Options — see prefillIfOnboarded) — check
  // the current status synchronously before showing anything, so "ready"
  // never flashes the loading view first.
  renderSetupState(await getLlmStatus());

  form.classList.add("hidden");
  slogan.classList.add("hidden");
  confirmation.classList.remove("hidden");
});

prefillIfOnboarded();
