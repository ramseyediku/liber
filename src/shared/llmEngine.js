// Thin RPC shim over the Offscreen Document that actually hosts the
// on-device LLM engine (src/offscreen/offscreen.js) — the engine itself
// runs in a real Worker spawned from there (src/offscreen/llmWorker.js).
//
// A literal `new Worker()` created directly inside the MV3 background
// service worker is NOT supported — confirmed via research: WebLLM's own
// official chrome-extension-webgpu-service-worker example runs the engine
// directly on the service worker's own thread instead of nesting a Worker,
// and the relevant spec issues (w3c/webextensions#287,
// whatwg/html#8362) remain unresolved. `chrome.offscreen` is the
// documented, fully-supported way to get a real Worker: it creates a
// hidden extension page with a genuine Window, which can spawn one with
// zero spec ambiguity.
//
// background.js's call sites (warmup/extractJobFields/unloadEngine) are
// unchanged from before this split — this module's exported signatures are
// identical, only what's behind them moved.

export class LlmNotReadyError extends Error {
  constructor(status) {
    super(`Liber's on-device model isn't ready yet (${status.state}).`);
    this.name = "LlmNotReadyError";
    this.status = status;
  }
}

let offscreenReadyPromise = null;

async function ensureOffscreenDocument() {
  if (offscreenReadyPromise) return offscreenReadyPromise;
  offscreenReadyPromise = (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: "src/offscreen/offscreen.html",
      reasons: ["WORKERS"],
      justification: "Hosts the on-device model's Worker for local job-field extraction.",
    });
  })();
  return offscreenReadyPromise;
}

async function callOffscreen(type, payload) {
  await ensureOffscreenDocument();
  const response = await browser.runtime.sendMessage({ type, ...payload });
  if (response?.ok === false) {
    throw new LlmNotReadyError(response.status);
  }
  return response?.result;
}

export function warmup() {
  return callOffscreen("LIBER_OFFSCREEN_WARMUP", {});
}

export function extractJobFields(scopeText) {
  return callOffscreen("LIBER_OFFSCREEN_EXTRACT", { scopeText });
}

export async function unloadEngine() {
  await callOffscreen("LIBER_OFFSCREEN_UNLOAD", {});
}
