// On-device LLM field extraction, replacing content.js's old synonym-based
// matcher. Runs entirely in the background service worker — content.js only
// ever ships bounded page text here (see LIBER_FLOW_STEP in background.js);
// it never talks to WebLLM directly. That's deliberate: this engine (and the
// multi-GB model behind it) is a single shared resource, not something every
// <all_urls> content-script instance could load on its own.
//
// Requires WebGPU, which Chrome exposes to extension service workers (since
// Chrome 124) but Firefox does not reliably support yet — this is a
// Chrome-only capability for now, by design; see docs/roadmap.md.
import { CreateMLCEngine } from "../../vendor/web-llm.js";
import { setLlmStatus, getLlmStatus } from "./llmStatus.js";
import { normalizeScrapedText } from "./textNormalize.js";

// Qwen2.5-0.5B-Instruct, not the originally-planned 3B — ~945MB vs ~2.5GB
// of GPU memory (a reasonable proxy for download size), chosen after
// real-world testing surfaced how painful the first-install download is on
// a slow connection. Qwen2.5's small sizes hold up better on simple
// instruction-following/structured-extraction tasks than similarly-sized
// alternatives (SmolLM2 at a similar footprint, tried first in discussion,
// is noticeably weaker here) — but this is a size/accuracy tradeoff, not a
// free win; see docs/roadmap.md for the fuller writeup and what to do if
// extraction accuracy proves unreliable at this size.
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

// Caps prompt size for latency, not correctness — content.js's
// resolvePageScope/collectPageText (or background.js's
// liberScanInjectedPage, for a cross-navigation/cross-tab scan) already
// bound the scope to a dialog/landmark, so this is a second, cheap safety
// net against an unusually large scope.
const SCOPE_TEXT_MAX_LENGTH = 3000;

const SNAPSHOT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    jobTitle: { type: "string" },
    company: { type: "string" },
    location: { type: "string" },
  },
  required: ["jobTitle", "company", "location"],
});

const SYSTEM_PROMPT =
  'You extract job application details from raw page text taken from a ' +
  "job listing or application form. Respond with a JSON object with " +
  'exactly these fields: "jobTitle", "company", "location". Use the ' +
  'empty string "" for any field you cannot find in the text with ' +
  "reasonable confidence — never guess or invent a value.";

export class LlmNotReadyError extends Error {
  constructor(status) {
    super(`Liber's on-device model isn't ready yet (${status.state}).`);
    this.name = "LlmNotReadyError";
    this.status = status;
  }
}

// Module-level singleton — one engine for the whole service worker, shared
// across every tab's extraction calls.
let enginePromise = null;

async function checkWebGpuSupport() {
  if (!("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

// Writes a status and throws an error carrying that *exact* status object,
// in the same step — so a caller catching the rejection always has the
// status that caused it, with no gap in which a concurrent call could read
// a stale/different status back out of storage. (An earlier version had
// extractJobFields call warmup() then separately re-read getLlmStatus()
// afterward; those two steps could land on opposite sides of the next
// setLlmStatus() write, occasionally reporting "still loading" for a click
// that was actually about to fail as "unsupported".)
async function failWith(code, partialStatus) {
  const status = await setLlmStatus(partialStatus);
  const err = new Error(status.message);
  err.name = "LlmLoadError";
  err.code = code;
  err.status = status;
  throw err;
}

async function loadEngine() {
  await setLlmStatus({
    state: "loading",
    progress: 0,
    message: "Checking device support…",
  });

  const supported = await checkWebGpuSupport();
  if (!supported) {
    await failWith("unsupported", {
      state: "unsupported",
      progress: 0,
      message:
        "This browser/device doesn't support WebGPU, which Liber's on-device model requires.",
    });
  }

  try {
    const engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (report) => {
        setLlmStatus({
          state: "loading",
          progress: Math.round((report.progress || 0) * 100),
          message: report.text,
        });
      },
    });
    await setLlmStatus({ state: "ready", progress: 100, message: "Ready" });
    return engine;
  } catch (err) {
    await failWith("error", {
      state: "error",
      progress: 0,
      message: err?.message || "Failed to load the on-device model.",
    });
  }
}

// Lazily creates (or returns the in-flight/already-created) engine. Safe to
// call repeatedly and from multiple places (onInstalled, onStartup, the
// onboarding warmup message, and extractJobFields itself all call this)
// without triggering a second model download.
export function warmup() {
  if (enginePromise) return enginePromise;

  enginePromise = loadEngine();

  enginePromise.catch((err) => {
    // "unsupported" is a stable fact about this browser/device — retrying
    // would just re-run the same check for the same answer, and reopens
    // the stale-status window above on every single click for no chance
    // of a different outcome. A transient load failure ("error"), on the
    // other hand, genuinely might succeed if retried, so that case clears
    // the cached attempt and lets the next call start fresh.
    if (err?.code !== "unsupported") enginePromise = null;
  });

  return enginePromise;
}

// Resolves bounded scope text (from content.js or background.js's own
// cross-navigation/cross-tab scan) into
// {jobTitle, company, location}. Throws LlmNotReadyError — never falls back
// to any other extraction method — if the engine isn't ready yet; the caller
// (background.js) decides what to show the user for that case.
export async function extractJobFields(scopeText) {
  let engine;
  try {
    engine = await warmup();
  } catch (err) {
    throw new LlmNotReadyError(err.status || (await getLlmStatus()));
  }

  const text = (scopeText || "").slice(0, SCOPE_TEXT_MAX_LENGTH);

  const completion = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object", schema: SNAPSHOT_SCHEMA },
    temperature: 0,
  });

  const raw = JSON.parse(completion.choices[0].message.content);
  return {
    jobTitle: normalizeScrapedText(raw.jobTitle),
    company: normalizeScrapedText(raw.company),
    location: normalizeScrapedText(raw.location),
  };
}
