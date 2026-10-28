// Hosts the actual on-device LLM engine — relocated here from
// src/shared/llmEngine.js, which is now just a thin RPC shim calling into
// this document (see that file's header for why). This is a genuine
// Offscreen Document (a hidden extension page with a real Window),
// created on demand by llmEngine.js's ensureOffscreenDocument(). The
// engine itself runs in a real Worker (./llmWorker.js), spawned from here
// via WebLLM's CreateWebWorkerMLCEngine — confirmed directly against the
// vendored bundle that this is the officially-supported way to host the
// engine off the main thread; a literal `new Worker()` created directly
// inside the MV3 background service worker is NOT supported (unresolved
// spec territory as of this writing), which is the entire reason this
// Offscreen Document exists rather than background.js just spawning the
// worker itself.
import "../../vendor/browser-polyfill.js";
import { CreateWebWorkerMLCEngine } from "../../vendor/web-llm.js";
import { tryParseCompleteSnapshot } from "../shared/partialJsonSnapshot.js";

// Offscreen Documents only expose chrome.runtime (messaging) — chrome.storage
// is deliberately NOT available here (confirmed directly: typeof
// chrome.storage is "undefined" inside this document), specifically so an
// offscreen document can't be used as a background-page replacement. So
// liber_llm_status can't be written from here the way llmStatus.js's
// setLlmStatus/getLlmStatus assume — status instead lives in this local
// variable, relayed to background.js (which does have storage access) via
// LIBER_OFFSCREEN_STATUS, which persists it through llmStatus.js on that
// side. This is also why the engine silently never loaded before this fix:
// every setLlmStatus() call here threw on `browser.storage.session`, which
// aborted loadEngine()/warmup() before they got anywhere.
let localStatus = { state: "idle", progress: 0, message: "" };

function getLlmStatus() {
  return localStatus;
}

function setLlmStatus(partial) {
  localStatus = { ...localStatus, ...partial };
  browser.runtime.sendMessage({ type: "LIBER_OFFSCREEN_STATUS", status: localStatus }).catch(() => {});
  return localStatus;
}

// Qwen2.5-0.5B-Instruct, not the originally-planned 3B — ~945MB vs ~2.5GB
// of GPU memory (a reasonable proxy for download size), chosen after
// real-world testing surfaced how painful the first-install download is on
// a slow connection. See docs/roadmap.md's "Model size vs. accuracy" for
// the fuller writeup.
const MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

// Caps prompt size for latency, not correctness — content.js's scope
// resolution already bounds the scope to a specific card/container, this
// is a second, cheap safety net against an unusually large one.
const SCOPE_TEXT_MAX_LENGTH = 3000;

// Property order here is load-bearing, not just readable: WebLLM's
// grammar-constrained JSON mode generates object keys in the order given in
// the schema, and partialJsonSnapshot.js's early-stop scan assumes this
// exact jobTitle → company → location order to detect "all three fields
// are done" before the closing `}` arrives — see extractJobFields below.
const SNAPSHOT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    jobTitle: { type: "string" },
    company: { type: "string" },
    location: { type: "string" },
  },
  required: ["jobTitle", "company", "location"],
});

// Short and strict on purpose — a small model is more prone to padding
// field values with extra words than to adding prose outside the JSON
// (the grammar constraint already rules that out structurally), and every
// extra word in a value is a token the early-stop logic below has to wait
// through before it can abort generation.
const SYSTEM_PROMPT =
  "Extract job application details from raw page text. Respond with a " +
  'JSON object with exactly these fields: "jobTitle", "company", ' +
  '"location". Keep each value short — a few words, not a sentence. Use ' +
  'the empty string "" for any field you cannot find with reasonable ' +
  "confidence — never guess or invent a value.";

// Module-level singleton — one engine for this offscreen document's whole
// lifetime, shared across every LIBER_OFFSCREEN_EXTRACT request.
let enginePromise = null;
let worker = null;

// No standardized WebGPU API exposes "this is a software/fallback
// adapter" directly — only GPUAdapterInfo (the newer synchronous
// adapter.info property, or the older async adapter.requestAdapterInfo())
// exposing vendor/architecture/device/description strings that MIGHT
// mention a known software renderer. Best-effort heuristic only: catches
// known software renderers (SwiftShader, llvmpipe, a generic "software"
// mention), not a guarantee — an unrecognized/future software renderer
// wouldn't be caught. See docs/roadmap.md.
const SOFTWARE_RENDERER_HINTS = ["swiftshader", "llvmpipe", "software"];

async function isSoftwareAdapter(adapter) {
  try {
    const info = adapter.info || (await adapter.requestAdapterInfo?.());
    if (!info) return false;
    const haystack = [info.vendor, info.architecture, info.device, info.description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return SOFTWARE_RENDERER_HINTS.some((hint) => haystack.includes(hint));
  } catch {
    return false; // Inconclusive — don't block a device over a failed check.
  }
}

async function checkWebGpuSupport() {
  if (!("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    return !(await isSoftwareAdapter(adapter));
  } catch {
    return false;
  }
}

// Writes a status and throws an error carrying that *exact* status object,
// in the same step — see llmEngine.js's original version of this comment
// for why (preserved verbatim, still true here).
async function failWith(code, partialStatus) {
  const status = await setLlmStatus(partialStatus);
  const err = new Error(status.message);
  err.name = "LlmLoadError";
  err.code = code;
  err.status = status;
  throw err;
}

function spawnWorker() {
  if (!worker) {
    worker = new Worker(new URL("./llmWorker.js", import.meta.url), { type: "module" });
  }
  return worker;
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
        "This device's GPU can't run the local scraping fast enough (no WebGPU, or a software/emulated GPU).",
    });
  }

  try {
    const engine = await CreateWebWorkerMLCEngine(spawnWorker(), MODEL_ID, {
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
// call repeatedly without triggering a second model download.
function warmup() {
  if (enginePromise) return enginePromise;

  enginePromise = loadEngine();

  enginePromise.catch((err) => {
    // "unsupported" is a stable fact about this browser/device — retrying
    // would just re-run the same check for the same answer. A transient
    // load failure ("error") genuinely might succeed if retried, so that
    // case clears the cached attempt and lets the next call start fresh.
    if (err?.code !== "unsupported") enginePromise = null;
  });

  return enginePromise;
}

// Frees the loaded model's WASM runtime and GPU-resident weights. Safe to
// call when nothing is loaded (or still loading/failed) — the weight files
// themselves stay cached by WebLLM via the Cache API regardless, so a
// later warmup() is a reload (re-instantiate + re-upload to GPU), not a
// re-download.
async function unloadEngine() {
  if (!enginePromise) return;
  const promise = enginePromise;
  enginePromise = null;
  try {
    const engine = await promise;
    await engine.unload();
  } catch {
    // Never successfully loaded (still loading, or failed) — nothing to
    // unload; clearing enginePromise above already lets a fresh warmup()
    // start over.
  } finally {
    await setLlmStatus({ state: "idle", progress: 0, message: "" });
  }
}

// Resolves bounded scope text into {jobTitle, company, location}. Throws
// an error carrying the current llmStatus — never falls back to any other
// extraction method — if the engine isn't ready yet; background.js (via
// llmEngine.js) decides what to show the user for that case.
async function extractJobFields(scopeText) {
  let engine;
  try {
    engine = await warmup();
  } catch (err) {
    const notReady = new Error("not ready");
    notReady.status = err.status || (await getLlmStatus());
    throw notReady;
  }

  const text = (scopeText || "").slice(0, SCOPE_TEXT_MAX_LENGTH);

  const stream = await engine.chat.completions.create({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object", schema: SNAPSHOT_SCHEMA },
    temperature: 0,
    stream: true,
  });

  // Stream tokens and stop reading as soon as all three fields (in the
  // schema's fixed order — see SNAPSHOT_SCHEMA's comment) have closed,
  // rather than waiting for the model to also emit the closing `}` and its
  // end-of-generation token. interruptGenerate() then tells the engine
  // itself to stop producing further tokens. This works unmodified through
  // the Worker-hosted engine too — CreateWebWorkerMLCEngine's returned
  // proxy exposes the same streaming chat.completions.create()/
  // interruptGenerate() surface as the direct engine, transparently
  // forwarded over the worker's postMessage (confirmed directly against
  // the vendored bundle).
  let buffer = "";
  let result = null;
  for await (const chunk of stream) {
    buffer += chunk.choices?.[0]?.delta?.content || "";
    result = tryParseCompleteSnapshot(buffer);
    if (result) break;
  }

  if (result) {
    await engine.interruptGenerate();
  } else {
    // Stream ended on its own (fields never matched the expected fixed
    // order/shape — shouldn't happen under grammar-constrained JSON mode,
    // but this is the fallback if it ever does) — parse whatever the model
    // finished with.
    try {
      result = JSON.parse(buffer);
    } catch {
      result = { jobTitle: "", company: "", location: "" };
    }
  }

  return {
    jobTitle: result.jobTitle || "",
    company: result.company || "",
    location: result.location || "",
  };
}

// RPC surface called by llmEngine.js (in the background service worker)
// via browser.runtime.sendMessage. A real Error can't cross that
// structured-clone boundary as an Error instance, so a not-ready/failed
// request is reported back as a plain {ok:false, status} payload instead —
// llmEngine.js reconstructs a real LlmNotReadyError from it on the other
// side.
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "LIBER_OFFSCREEN_WARMUP") {
    return (async () => {
      try {
        await warmup();
        return { result: await getLlmStatus() };
      } catch (err) {
        return { ok: false, status: err.status || (await getLlmStatus()) };
      }
    })();
  }

  if (message.type === "LIBER_OFFSCREEN_EXTRACT") {
    return (async () => {
      try {
        return { result: await extractJobFields(message.scopeText) };
      } catch (err) {
        return { ok: false, status: err.status || (await getLlmStatus()) };
      }
    })();
  }

  if (message.type === "LIBER_OFFSCREEN_UNLOAD") {
    return (async () => {
      await unloadEngine();
      return { result: true };
    })();
  }
});
