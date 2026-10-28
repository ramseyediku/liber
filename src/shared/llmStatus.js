// Shared on-device-model status, mirroring logStorage.js's shape: one
// session-backed record (debugging/UI data, not something that needs to
// survive a browser restart — the engine itself is re-created fresh every
// service-worker start anyway) rather than per-tab, since onboarding and
// background.js's extraction pipeline all read the same global model
// state. Read directly via storage.onChanged by extension-page contexts
// (onboarding.js) and by background.js itself (which relays live loading
// progress to whichever tab is currently waiting on an extraction — see
// background.js's "working" phase push) — there's no longer a tab-wide
// broadcast here, since content.js no longer renders anything from this
// record directly (its old progress badge was replaced by the post-submit
// extraction popup, driven by a per-tab LIBER_EXTRACTION_STATUS push
// instead of this file's status).

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
