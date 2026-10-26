// First-run profile form: saves name + profession, then shows the confirmation message.
import { getProfile, setProfile } from "../shared/storage.js";
import { getLlmStatus } from "../shared/llmStatus.js";

LiberTheme.initToggle(document.getElementById("theme-toggle"));

const form = document.getElementById("onboarding-form");
const confirmation = document.getElementById("confirmation");
const slogan = document.querySelector("p");
const llmStatusEl = document.getElementById("llm-status");

// Mirrors the dashboard's status chip (dashboard-core.js) — same
// liber_llm_status record, same browser.storage.onChanged live-update
// pattern, just rendered as a line of text here instead of a chip.
function renderLlmStatus(status) {
  if (!status || status.state === "idle") {
    llmStatusEl.classList.add("hidden");
    return;
  }
  llmStatusEl.classList.remove("hidden");
  const text =
    status.state === "ready"
      ? "On-device AI model: ready. Click Apply on any job posting to try it."
      : status.state === "unsupported"
        ? "Your browser/device doesn't support the on-device model (needs WebGPU) — you can still track applications manually."
        : status.state === "error"
          ? `On-device AI model failed to load (${status.message || "unknown error"}).`
          : `Setting up on-device AI model… ${status.progress || 0}% — a one-time download, happening in the background. You can start using Liber in the meantime; applications just won't be scraped automatically until this finishes.`;
  llmStatusEl.textContent = text;
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session" && changes.liber_llm_status) {
    renderLlmStatus(changes.liber_llm_status.newValue);
  }
});

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
  browser.runtime.sendMessage({ type: "LIBER_LLM_WARMUP" }).catch(() => {});
  renderLlmStatus(await getLlmStatus());

  form.classList.add("hidden");
  slogan.classList.add("hidden");
  confirmation.classList.remove("hidden");
});

prefillIfOnboarded();
