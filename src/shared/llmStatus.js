// Shared on-device-model status, mirroring logStorage.js's shape: one
// session-backed record (debugging/UI data, not something that needs to
// survive a browser restart — the engine itself is re-created fresh every
// service-worker start anyway) rather than per-tab, since onboarding and
// both dashboard pages all show the same global model state.

const STATUS_KEY = "liber_llm_status";

const IDLE_STATUS = { state: "idle", progress: 0, message: "" };

export async function getLlmStatus() {
  const stored = (await browser.storage.session.get(STATUS_KEY))[STATUS_KEY];
  return stored || IDLE_STATUS;
}

export async function setLlmStatus(partial) {
  const current = await getLlmStatus();
  const next = { ...current, ...partial };
  await browser.storage.session.set({ [STATUS_KEY]: next });
  return next;
}
