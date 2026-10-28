// Runs inside a real Worker spawned by offscreen.js — WebLLM's
// WebWorkerMLCEngineHandler builds and owns its own internal MLCEngine
// (confirmed by reading vendor/web-llm.js directly: its constructor takes
// no engine argument) and expects exactly this "forward self.onmessage to
// the handler" wiring. See offscreen.js's header for why this lives in a
// genuine Worker rather than directly in the background service worker.
import { WebWorkerMLCEngineHandler } from "../../vendor/web-llm.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
