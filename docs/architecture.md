# Architecture

Liber is a Manifest V3 browser extension with no build step — the manifest
points directly at source files under `src/`, and `vendor/browser-polyfill.js`
provides the cross-browser `browser.*` API (so the same code runs on both
Chrome and Firefox) — except for scraping itself, which now requires WebGPU
(`src/offscreen/offscreen.js`) and is Chrome/Chromium-only in practice; see
"Required LLM, no fallback" in the `background.js` section.

## Components

### `src/content/content.js` — Content script

Injected into every page (`<all_urls>`, `document_idle`). A single click
listener in the capture phase matches `TRIGGER_PATTERN`
(`/\b(apply|submit|next|continue|review)\b/i` — word-boundary match on
root words rather than a hardcoded phrase list, so new button phrasings
work without adding a list entry, and `\b` keeps it from false-matching
inside unrelated words like "resubmit"/"submitted"). The content script
runs on every page via `<all_urls>`, not just job sites, so a plain
"Submit"/"Continue" button on an unrelated page (e.g. a checkout form)
matches too — harmless, since a capture with nothing extractable near it
just shows an empty/best-effort consent prompt the user can decline.

**The click itself is never blocked** (no `preventDefault` anywhere) —
the native action (navigation/form submission) always proceeds
immediately, whatever this file does in response.

### Single-click, consent-first capture

Earlier designs in this project tried to automatically detect "has the
user actually finished applying?" — first by running extraction on every
step in real time ("defer-and-watch"), then by capturing only the final
submit click ("capture-at-submit"), then by capturing every step and
waiting for the *absence* of a continuation signal (a dialog, a new tab, a
reload) to infer the flow was done ("multi-step capture"). All three
needed increasingly fragile machinery (grace-period timers, cross-tab
carryover, reload-vs-dialog heuristics tuned per-ATS) to approximate one
question the user can just answer directly. This design sidesteps the
question entirely: capture once, scoped tightly to the specific job, ask
the user "Save this job to your tracker?" before touching the model at
all, and only extract/save on "yes." See `docs/roadmap.md`'s "Capture flow
rewrite: single-click, consent-first" for the full history.

1. **Still a listings page.** `countVisibleJobTitles()` counts distinct
   visible job titles via `JOB_TITLE_HINTS`, excluding
   `input`/`select`/`textarea`/`label`/`button` elements from the match —
   the "broad" hints (`position`/`role`) are substring-matched against
   `id`/`class`/`data-testid`/`aria-label`, which also matches a real
   application form's own fields ("Current role", "Desired position").
   "Visible" means `isVisible()`'s `document.elementFromPoint()` check —
   whatever's actually topmost at an element's on-screen center point —
   not a layout/ARIA check (`offsetParent`/`aria-hidden`/`inert`). The
   ARIA-based version shipped first and broke on Indeed: its Easy Apply
   modal overlays the background job list without hiding or `aria-hide`-ing
   it, so the layout check kept seeing those cards as "visible" even once
   the modal was open. `elementFromPoint` instead reflects the real
   stacking order — a modal's backdrop sits on top of background content
   in virtually every real implementation regardless of whether the site
   marks it `aria-hidden`. The scanning loop breaks as soon as a second
   distinct title is found (every caller only ever asks "more than one?",
   so the return value saturates at 2).
2. **Multiple jobs visible** → `resolveMultiJobScope(clickedEl)` finds the
   *specific* card the click happened inside, via structural repetition
   detection (see "Scope resolution" below), rather than doing nothing the
   way earlier designs did on a listings page.
3. **Single job** → `resolveSingleJobScope(clickedEl)` scopes to the
   container around the clicked element specifically (proximity to the
   click), not just the nearest landmark/dialog/body anywhere in the
   document.
4. Either way, capture happens synchronously, before the click's own
   native action can change anything (`collectJobPostingLd()` +
   `collectPageText(scope)`), and a `renderConsentPopup()` — "Save this
   job to your tracker?", Yes/No, **nothing extracted or loaded yet** — is
   shown immediately. Declining sends nothing to `background.js` at all.
   Accepting shows `renderWorkingPopup(0)` locally and fire-and-forgets
   `LIBER_SAVE_REQUESTED {url, scopeText, structuredSnapshot}` —
   `background.js`'s `handleSaveRequested` is the one place extraction
   (JSON-LD first, the LLM only if still incomplete) and saving actually
   happen, see that section below.

**Suppression**: a module-level `awaitingConsentResponse` flag blocks
further trigger clicks from doing anything while a prompt is awaiting a
response *or* while an accepted one is still being extracted/saved — so a
multi-step wizard's later Next/Continue/Submit clicks (or just an impatient
second click) don't re-prompt before the first one is actually resolved.
"No" resets it instantly; "yes" deliberately doesn't — it only clears once
`LIBER_EXTRACTION_STATUS`'s `"done"` phase arrives, so the whole save window
is covered, not just the moment the popup was on screen. A same-tab SPA
route change to a genuinely different job is still free to prompt again
once whatever's currently pending resolves.

A real navigation (new tab, or a same-tab redirect) destroys this flag along
with the rest of the content-script instance — but if a prompt was still
*unanswered* at that point, it isn't simply lost: every fresh `content.js`
instance sends `LIBER_CHECK_PENDING_CONSENT` to `background.js` on load, and
if that redirect/new-tab was the destination of an unanswered prompt
(tracked there as `pendingConsentByTab`, see the `background.js` section),
it gets handed back here and `beginConsentFlow` shows the exact same prompt
again — same captured `{url, scopeText, structuredSnapshot}`, no
re-capture. An *answered* prompt (already saving, or already declined) has
nothing pending by then, so this is a no-op for it, by design.

Every step of this process (trigger matched, listing check, scope
resolved, capture, consent decision) goes through `logStep(step, detail)`,
which both `console.log`s on the page (prefixed `"Liber: "`) and relays a
`LIBER_LOG` message to `background.js` for `logStorage.js` to persist — so
the dashboard's activity log (`src/dashboard/` section) can show it live,
not just whoever happened to have that page's own devtools open.

### Scope resolution

- `findVisibleDialog()` — checks `[role="dialog"], [aria-modal="true"],
  dialog` (via `isVisible()`), then falls back to a generic overlay
  heuristic (visible, `position: fixed`/`absolute`, `z-index >= 100`,
  covering ≥30% of the viewport) for modals built without ARIA semantics.
  A heuristic, with the same accepted false-positive/negative risk as
  `isVisible()` itself (e.g. a large promo banner could theoretically
  qualify; a small corner toast won't).
- `resolvePageScope()` = `findVisibleDialog() || document.querySelector('form,
  main, [role="main"], article') || document.body` — the shared fallback
  tail for both scope-resolution paths below. On a split-view list+detail
  layout, this landmark search is typically what resolves to the detail
  pane itself.
- `resolveSingleJobScope(clickedEl)` = `clickedEl.closest(DIALOG_SELECTOR)
  || clickedEl.closest('form, main, [role="main"], article') ||
  resolvePageScope()` — proximity to the actual clicked element
  (`closest()`, walking up from the click), not `document.querySelector`'s
  first-match-anywhere-in-the-document behavior.
- `resolveMultiJobScope(clickedEl)` — on a listings page, finds the
  specific repeated card the click happened inside:
  1. `findRepeatedCardAncestor(clickedEl)` — walks up from the clicked
     element (bounded by `MAX_REPEAT_WALK_DEPTH`, 8 levels) looking for the
     first ancestor with a structurally-similar sibling: same tag name, and
     an overlapping class list at or above `CLASS_OVERLAP_THRESHOLD` (0.5,
     a Jaccard-style union/intersection ratio) — comparing structure only,
     ignoring text content, ids, and data-attribute values, which is
     exactly what differs between two otherwise-identical cards.
     `MIN_CARD_TEXT_LENGTH` (40 chars) skips any ancestor too small to
     plausibly be a real card — without this gate, the walk stops almost
     immediately at the Apply button's own thin wrapper div, which is
     nearly always structurally identical across every card on the page.
     All three constants are reasoned defaults, explicitly unmeasured
     against a broad site sample — same "accepted risk, bounded" spirit as
     `JOB_TITLE_MAX_LENGTH` elsewhere in this file.
  2. Falls back, in order, to the closest `article`, `li`,
     `[role="listitem"]`, or `[data-job-id]` ancestor.
  3. Falls back to `resolvePageScope()` — covering both the split-view
     detail-pane case and the final whole-page capture in one call.
- `collectPageText(scope)` — bounded/whitespace-collapsed/
  `SCOPE_TEXT_MAX_LENGTH`-capped `.innerText` read of that scope. Also
  strips page chrome first — `nav`/`header`/`footer`/`script`/`style`/
  `noscript` and their ARIA landmark equivalents are temporarily hidden
  (`display: none`), the text is read, then they're restored — rather than
  reading `.innerText` on a detached clone, which would just come back
  empty (`.innerText` needs live layout). Matters most when the resolved
  scope is the `document.body` fallback, which would otherwise include a
  whole site's nav/footer text in the (small) `SCOPE_TEXT_MAX_LENGTH`
  budget.

Only `jobTitle`/`company`/`location` are captured — the LLM prompt
(`src/offscreen/offscreen.js`) only asks for these three fields. See
`docs/roadmap.md` for `jobDescription`'s status.

### Field extraction, off content.js

`content.js` never resolves `jobTitle`/`company`/`location` itself — it
just ships plain scope text to `background.js` (via `LIBER_SAVE_REQUESTED`,
only once the user has consented), which turns it into those three fields
using an on-device LLM. An LLM reads the same bounded text as a human
would, so it doesn't depend on a site exposing any particular
markup/attribute convention — the tradeoff is "can the model find job
title/company/location in whatever text is actually there?" rather than
"does this site expose the right attribute?". See `docs/roadmap.md` for
the limitations this doesn't remove (model/device requirements, latency,
and the new failure modes an LLM introduces that a regex never could).

### `src/shared/llmEngine.js` — thin RPC shim over the Offscreen Document

A literal `new Worker()` created directly inside the MV3 background
service worker is not supported — confirmed via research: WebLLM's own
official `chrome-extension-webgpu-service-worker` example runs the engine
directly on the service worker's own thread instead of nesting a Worker,
and the relevant spec issues
([w3c/webextensions#287](https://github.com/w3c/webextensions/issues/287),
[whatwg/html#8362](https://github.com/whatwg/html/issues/8362)) remain
unresolved. `chrome.offscreen` is the documented, fully-supported way to
get a real Worker: it creates a hidden extension page with a genuine
`Window`, which can spawn one with zero spec ambiguity.

So `background.js` never talks to WebLLM directly — it calls this module,
which is a thin RPC layer:

- `ensureOffscreenDocument()` — memoized; checks `chrome.offscreen.hasDocument()`
  before creating one, so repeated calls are free once the document
  exists.
- `callOffscreen(type, payload)` — ensures the document exists, then
  `browser.runtime.sendMessage({type, ...payload})` to it, and either
  returns `response.result` or throws a reconstructed `LlmNotReadyError`.
  A real `Error` can't cross `sendMessage`'s structured-clone boundary, so
  `offscreen.js` reports a not-ready/failed request back as a plain
  `{ok: false, status}` payload, and this module turns that back into a
  real `LlmNotReadyError` on the background-service-worker side — so
  `background.js`'s existing `err instanceof LlmNotReadyError` check works
  unmodified.
- `warmup()`, `extractJobFields(scopeText)`, `unloadEngine()`,
  `LlmNotReadyError` — same exported signatures as before this split, so
  `background.js`'s call sites didn't need to change; only what's behind
  them moved into `src/offscreen/offscreen.js`.

### `src/offscreen/` — the actual engine, hosted in a real Worker

- `offscreen.html` — a minimal, never-shown extension page (Offscreen
  Documents have no visible UI), loading `offscreen.js` as a module.
- `offscreen.js` — holds everything that used to live directly in
  `llmEngine.js`: `MODEL_ID` (`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`, ~945MB —
  see `docs/roadmap.md`'s "Model size vs. accuracy" for why this specific
  size/model was picked), `SNAPSHOT_SCHEMA` (property order
  `jobTitle → company → location` is load-bearing — WebLLM's
  grammar-constrained JSON mode generates keys in that order, and
  `partialJsonSnapshot.js`'s early-stop scan depends on it), the system
  prompt, WebGPU/software-adapter checks (`checkWebGpuSupport`/
  `isSoftwareAdapter`, see "WebGPU software-adapter heuristic" in
  `docs/roadmap.md`), and the memoized `enginePromise` singleton
  (`warmup()`/`unloadEngine()`). The one real change from before: `loadEngine()`
  now calls `CreateWebWorkerMLCEngine(spawnWorker(), MODEL_ID, {
  initProgressCallback })` instead of `CreateMLCEngine(MODEL_ID, {...})` —
  verified directly against the vendored `vendor/web-llm.js` bundle that
  the resulting `WebWorkerMLCEngine` proxy exposes the same
  `.chat.completions.create(...)` streaming API and
  `interruptGenerate()`/`unload()` methods as the direct engine,
  transparently forwarded over the worker's `postMessage` — so
  `extractJobFields`'s streaming + `tryParseCompleteSnapshot`-driven
  early-`interruptGenerate()` loop (see "Minimizing on-device LLM usage"
  below) carries over unmodified. A `chrome.runtime.onMessage` listener
  handles `LIBER_OFFSCREEN_WARMUP`/`LIBER_OFFSCREEN_EXTRACT`/
  `LIBER_OFFSCREEN_UNLOAD`, catching `LlmNotReadyError`-shaped failures and
  re-serializing them as plain `{ok:false, status}` objects per
  `llmEngine.js`'s plumbing note above.
- `llmWorker.js` — the actual Worker, spawned from `offscreen.js` via
  `new Worker(new URL("./llmWorker.js", import.meta.url), {type:
  "module"})`. Just installs WebLLM's `WebWorkerMLCEngineHandler`
  (confirmed directly against the vendored bundle: its constructor takes
  no engine argument — it builds its own internal engine and wires
  `postMessage`/`onmessage` for exactly this usage) and forwards
  `self.onmessage` to it.

**Dead end worth documenting so it isn't rediscovered**: WebLLM also
exports `CreateExtensionServiceWorkerMLCEngine`/
`ExtensionServiceWorkerMLCEngineHandler`, which looked at first like the
right caller↔remote-host pairing for this. On inspection, that handler
class calls `super()` with no arguments and its parent
(`WebWorkerMLCEngineHandler`) always builds its own fresh internal engine
— confirmed directly in the vendored source — so it can't be handed an
already-constructed Worker-hosted engine. It's designed for "host a direct
engine in-process, expose it over a port to a remote caller" (i.e. the
*previous* direct-in-service-worker design, with port-based multi-context
access bolted on), not for chaining behind a real Worker. Plain
`chrome.runtime.sendMessage`/`onMessage` between `background.js` (via
`llmEngine.js`) and `offscreen.js` is simpler and avoids fighting that
class's actual constructor contract.

**MV3 service-worker suspension** no longer directly affects the engine's
lifetime the way it used to — the engine now lives in the Offscreen
Document's own module state, not the background service worker's. The
Offscreen Document itself persists independent of service-worker
suspension/restart once created (`ensureOffscreenDocument()` is memoized
per service-worker lifetime, but the document itself isn't proactively
torn down by `unloadEngine()` — only the engine inside it unloads). The
underlying "cold reload, not re-download" tradeoff is unchanged: WebLLM
caches downloaded weight files via the Cache API, so re-creating the
engine is a reload (re-instantiating WASM and re-uploading weights to the
GPU), not a re-download, but still costs a few seconds. See
`docs/roadmap.md`.

### Minimizing on-device LLM usage

The LLM is a real RAM/CPU/GPU cost, worth avoiding when nothing needs it:

- **Structured data first.** `collectJobPostingLd()` (content.js) parses
  any `<script type="application/ld+json">` `JobPosting` block — common on
  Greenhouse/Lever/Workday and most ATS-hosted job pages — into
  `{jobTitle, company, location}` *before* anything LLM-related happens,
  at the same moment it captures `scopeText`. When it's complete,
  `background.js`'s `handleSaveRequested` uses it directly and never calls
  `extractJobFields` at all. A partial read (some but not all fields)
  still gets merged in for free — structured data is deterministic, so
  it's preferred over the LLM's guess for whichever fields it did find
  (`mergeSnapshot`), the LLM still runs to fill the rest. The pure parsing
  logic lives once, canonically, in `src/shared/jobPostingLd.js`
  (unit-tested, `jobPostingLd.test.js`) — content scripts can't `import`
  modules, so it's duplicated inline in `content.js`'s own
  `collectJobPostingLd`; keep both in sync.
- **Strictly lazy loading.** `warmup()` is never called speculatively —
  not on `onInstalled`/`onStartup`, and not on capture either. It's only
  ever reached via `extractJobFields` inside `handleSaveRequested`, which
  only runs once the user has explicitly accepted the "Save this job to
  your tracker?" prompt. The one exception is `onboarding.js`, which still
  sends `LIBER_LLM_WARMUP` unconditionally on page load — a deliberate,
  separate early-preload for first-time setup, not a contradiction of the
  per-application rule.
- **Early unload, immediate.** `unloadEngine()` frees the engine's WASM
  runtime/GPU weights (the downloaded weight files themselves stay cached
  via the Cache API, so a later `warmup()` is a reload, not a re-download)
  and resets status to `"idle"`. `background.js`'s `maybeUnloadEngineAfter`
  calls it right after *every* `handleSaveRequested` request finishes
  (success or failure) — checked against the in-memory `extractingTabs`
  set first, so unloading after one tab's finished request doesn't yank
  the engine out from under a different tab's still-in-flight one. Also
  called via a recurring `browser.alarms` check (`liber-llm-idle-check`,
  every 2 minutes) as a backstop for a model preloaded by onboarding but
  never actually used for an extraction.
- **URL-keyed extraction cache.** `background.js`'s `urlExtractionCache`
  (a bounded `Map`) skips re-running the LLM entirely on a URL it's
  already extracted — the same job URL can recur across unrelated clicks
  (e.g. a validation error sends the user back to retry), so a repeat
  request for that URL still skips the LLM.
- **Early stop on generation.** `extractJobFields` (now in
  `offscreen.js`) streams (`stream: true`) instead of waiting for one
  blocking response, and scans the growing buffer with
  `src/shared/partialJsonSnapshot.js`'s `tryParseCompleteSnapshot()` — a
  fixed-field-order regex that matches as soon as `jobTitle`, `company`,
  and `location` have all closed, before the model's closing `}`/
  end-of-generation token ever arrives. The moment it matches,
  `engine.interruptGenerate()` tells the engine to stop producing further
  tokens — this call is forwarded transparently over the Worker's
  `postMessage`, confirmed working unmodified through the new
  Worker-hosted engine.

### `src/shared/llmStatus.js` — Shared model-load status

One session-backed record (`liber_llm_status`, mirroring `logStorage.js`'s
single-shared-key shape) — `{ state: "idle" | "loading" | "ready" |
"unsupported" | "error", progress, message }`. **Not writable from
`offscreen.js` directly** — confirmed directly (`typeof chrome.storage` is
`"undefined"` inside an Offscreen Document's console): Offscreen Documents
deliberately expose only `chrome.runtime` messaging, not `chrome.storage`,
specifically so they can't be used as a background-page replacement. This
broke the engine entirely the first time the offscreen split landed — every
`setLlmStatus()` call inside `offscreen.js` threw on `browser.storage`
being undefined, aborting `loadEngine()`/`warmup()` before anything loaded,
silently (no status was ever written, so the setup page just sat on its
default "loading" placeholder forever). Fixed by having `offscreen.js` keep
status in a local module-level variable and relay every change to
`background.js` via `LIBER_OFFSCREEN_STATUS` — `background.js` (which does
have `chrome.storage`) is the only context that actually persists it now.
Read two ways:

- By `onboarding.js` (via `browser.storage.onChanged`, same pattern
  already used for jobs/logs) to drive its post-signup setup page's
  4-state UI — see "Post-signup setup page" in `docs/roadmap.md`.
- By `background.js` itself (also via `storage.onChanged`) to relay live
  loading progress to whichever tab(s) currently have a request in the
  `"extracting"` phase, via a per-tab `LIBER_EXTRACTION_STATUS` push — see
  the `background.js` section below.

Not read by `dashboard-core.js` (no status chip exists) or pushed to every
open tab generically — `content.js` only ever renders from the narrower,
per-tab `LIBER_EXTRACTION_STATUS` message.

### `src/background/background.js` — Background service worker

No longer tracks any per-tab persisted state at all — there's nothing left
to persist. Each accepted "Save this job to your tracker?" click is one
bounded async chain (`handleSaveRequested`) that runs to completion
independent of tab lifecycle; a mid-request tab close just means its
eventual result-delivery push fails and falls through to a plain OS
notification, with no special cleanup needed.

Responsibilities:
- On first install, opens the onboarding page. No eager `warmup()` call
  here (or on `onStartup`) — see "Minimizing on-device LLM usage" above.
- Registers a recurring `browser.alarms` check (`liber-llm-idle-check`,
  every 2 minutes — `alarms.create()` with an existing name just resets
  its schedule, so calling this on every service-worker startup, not
  once-ever, is the intended pattern). Its listener unloads the engine
  (`llmEngine.unloadEngine()`) if `lastLlmActivityAt` (module state) is
  older than `LLM_IDLE_UNLOAD_MS` (5 minutes).
- `LIBER_LLM_WARMUP` → calls `warmup()` directly and sets
  `lastLlmActivityAt = Date.now()`, then returns the current
  `getLlmStatus()` synchronously. Sent only by `onboarding.js`,
  unconditionally, on page load.
- `LIBER_LOG` → persists the entry via `logStorage.js`'s `appendLog`
  (fire-and-forget; a logging call must never block or fail the scrape
  it's reporting on).
- `LIBER_SAVE_REQUESTED` → `handleSaveRequested(tabId, {url, scopeText,
  structuredSnapshot})`, fire-and-forget (the real result is delivered
  asynchronously via `LIBER_EXTRACTION_STATUS`, not a direct reply): adds
  `tabId` to the in-memory `extractingTabs` set, pushes an initial
  `{phase: "working", progress: 0}`, then resolves a snapshot — a complete
  `structuredSnapshot` is used as-is (skipping the LLM entirely);
  otherwise `scopeText` is resolved via the URL-keyed cache or
  `extractJobFields` (merged with any partial `structuredSnapshot` via
  `mergeSnapshot`, since structured data outranks the LLM's guess). The
  merged snapshot is normalized (`normalizeScrapedText()`, uniformly
  regardless of source) and passed to `addJob` — `null` back means a
  duplicate (existing composite-key dedup, see "Design notes: dedup key"
  below), anything else means it saved. Either result, plus a thrown
  `LlmNotReadyError` (→ the one-per-tab "Liber can't scrape this
  application yet" notification, `showNotReadyPrompt`) or any other
  failure, is logged and reported as an `outcome`
  (`"saved"`/`"duplicate"`/`"failed"`) via `LIBER_EXTRACTION_STATUS
  {phase: "done", outcome}`. If that push fails (no content script to
  deliver to — tab closed, or navigated to a restricted page),
  `showSaveResultNotification` falls back to a plain OS notification with
  the same outcome text, no buttons (consent already happened in-page, so
  there's no decision left for notification buttons to make). Either way,
  finishes by fire-and-forgetting `maybeUnloadEngineAfter(tabId)`.
- Answers `CHECK_ONBOARDED` messages by checking `isOnboarded()`.
- Relays an unanswered consent prompt across a redirect/new tab via
  `pendingConsentByTab` (a `Map<tabId, {url, scopeText, structuredSnapshot,
  capturedAt}>`): `LIBER_CONSENT_PENDING` records one the instant
  `content.js` shows it, `LIBER_CONSENT_RESOLVED` clears it the instant the
  user answers, and `LIBER_CHECK_PENDING_CONSENT` — sent by every
  `content.js` instance on load — hands it to whichever page asks first,
  either the same tab (a fresh instance after a same-tab redirect) or a new
  tab opened from it (via `browser.tabs.get(tabId).openerTabId`), bounded by
  `PENDING_CONSENT_TTL_MS` (2 minutes) and deleted on read either way so it's
  only ever resumed once. See `docs/roadmap.md`'s "Repeat-prompt suppression
  is in-memory only" for why this is narrower than full flow-carryover (it
  only ever resumes one already-shown, still-unanswered prompt).
- `browser.tabs.onRemoved` clears `notReadyNotifiedTabs` and
  `pendingConsentByTab` for the closed tab — nothing else needs cleanup, by
  design (see above).

**Required LLM, no fallback.** There's no path back to the old synonym
matcher — if WebGPU/the model isn't available, Liber shows the "not ready"
notification above rather than silently degrading to a worse extraction
method. This was a deliberate choice over keeping both: scraping is now
Chrome/Chromium-only (WebGPU support on Firefox is still inconsistent, so
despite `manifest.json` still shipping `browser_specific_settings.gecko`,
the extraction path doesn't work there today) rather than maintaining two
extraction strategies indefinitely. See `docs/roadmap.md`.

### `src/shared/logStorage.js` — Rolling scraping-activity log

Backed by `storage.session` (debugging data, not something that needs to
survive a browser restart) — one shared list (`liber_logs`), not per-tab,
since the dashboard shows it page-wide across however many tabs logged to
it. `appendLog(entry)` pushes a `{ ...entry, timestamp }` and caps the list
at the most recent 200 entries (`getLogs`/`clearLogs` round it out). Fed by
`background.js`'s `LIBER_LOG` handler, which is in turn fed by
`content.js`'s `logStep`.

### `src/shared/fieldMerge.js` — Pure snapshot-merge logic

`mergeField(stored, incoming)` and `mergeSnapshot(stored, incoming)` — no
DOM, no storage, just normalized (trimmed/lowercased/whitespace-collapsed)
string comparison, so it's unit-tested directly
(`src/shared/fieldMerge.test.js`, run via `node --test` or `npm test`, no
extra dependency). Per field: no incoming value keeps the stored one;
nothing stored yet adopts the incoming one; if one value contains the
other (e.g. stored `"San Francisco"`, incoming `"San Francisco, CA
94105"`) the more detailed one wins; if neither contains the other, the
stored value is kept and the field is reported as a conflict for the
caller to log. Used once per request now (merging a partial JSON-LD read
with the LLM's output for that same single capture), not across multiple
steps — there's only ever one snapshot per request in this design.

### `src/shared/jobPostingLd.js` — Pure JSON-LD JobPosting parsing

`parseJobPostingLd(roots)` — takes an array of already-`JSON.parse`'d
`<script type="application/ld+json">` contents (the DOM querying and
`JSON.parse`-with-try/catch is the caller's job) and returns
`{jobTitle, company, location}`, unwrapping a bare `JobPosting` object, an
array of root objects, or a `@graph`-wrapped one, and returning the first
entry with at least one extractable field. No DOM, unit-tested directly
(`jobPostingLd.test.js`). This is the canonical version of logic that's
also duplicated inline in `content.js`'s `collectJobPostingLd` — content
scripts can't `import` ES modules, so this module exists for
testability/documentation even though nothing actually imports it at
runtime; keep both in sync if the parsing logic changes.

### `src/shared/partialJsonSnapshot.js` — Pure streamed-JSON early-stop scan

`tryParseCompleteSnapshot(buffer)` — scans a (possibly incomplete) streamed
JSON buffer for the moment a fixed-order `{jobTitle, company, location}`
object's three string values are all fully closed, using a single regex
built from `FIELD_ORDER`, without needing the whole object (its closing
`}`) to have arrived. Decodes escaped characters in matched values via
`JSON.parse('"' + raw + '"')` rather than reimplementing JSON's string
escaping. No DOM, no engine — pure string scanning, unit-tested directly
(`partialJsonSnapshot.test.js`). Used by `offscreen.js`'s
`extractJobFields` to call `engine.interruptGenerate()` as early as
possible; see "Minimizing on-device LLM usage" above.

### `src/shared/storage.js` — Storage layer

The single source of truth for reading/writing extension data. Wraps
`browser.storage.local` so nothing else touches raw storage calls directly.

- `getAllJobs` / `addJob` / `updateJob` / `deleteJob` — job CRUD, keyed under
  `liber_jobs`. `addJob` skips inserting a job whose composite key already
  exists — see "Design notes: dedup key" below.
- `getProfile` / `setProfile` / `isOnboarded` — user profile, keyed under
  `liber_profile`.
- `STATUS` / `STATUS_META` — the status enum (`applied`, `interviewing`,
  `rejected`, `ghosted`) and their display label/color.

### `src/dashboard/` — Toolbar popup and full view

Two separate pages share the same table-rendering logic
(`dashboard-core.js`):

- `dashboard.html` / `dashboard.js` / `dashboard.css` — the compact popup,
  registered as `action.default_popup`. No sidebar; only the columns that
  matter at a glance (company, title, status, notes).
- `dashboard-full.html` / `dashboard-full.js` / `dashboard-full.css` — a
  full-page view with the sidebar and every column, opened in a new tab via
  the popup's "Full view" button (`browser.tabs.create`). Its sidebar can
  collapse to icon-only via a toggle button; the collapsed state is saved to
  `localStorage` (`liber_sidebar_collapsed`) and restored without replaying
  the transition on load.

`dashboard-core.js`'s `initDashboard()` renders the jobs table
(`getAllJobs`) — a status `<select>` colored per status, a notes button that
opens a small popover to edit notes, truncated company/title/location cells
that expand in place on click, a delete button, and a greeting built from
the saved profile (with the user's initial shown in an avatar badge that
opens a read-only profile popover on click) — and re-renders automatically
on `browser.storage.onChanged` so either page stays in sync if a job is
saved elsewhere. `dashboard-shared.css` holds the table/select/popover
styles common to both pages.

The full view only (not the popup) also has a "Scrape Activity Log" —
a floating popover opened via a header button (`#logs-trigger`,
`dashboard-core.js`'s `openLogsPopover`), following the exact same
anchored-popover recipe as the notes/profile popovers
(`activePopover`/`activePopoverAnchor`,
`handleOutsideClick`/`handlePopoverKeydown`/`closeActivePopover` —
Escape, outside-click, and an explicit close button all dismiss it, plus
clicking the trigger again while open toggles it closed). Its content —
built fresh each time it opens, not persistent DOM — is `renderLogs()`,
reading `logStorage.js`'s rolling buffer and listing entries newest-first
(time, page hostname, step, pretty-printed detail dict), with a "Clear"
button (`clearLogs`). `renderLogs()` is a no-op whenever the logs popover
isn't the currently-open popover, which is what lets the
`storage.onChanged` listener keep calling it unconditionally on every
`liber_logs` change without erroring when it's closed.

No `liber_llm_status`-driven status chip exists anywhere in the dashboard
— see `docs/roadmap.md`'s "Post-signup setup page."

### `src/shared/theme.js` — Dark/light mode

A plain script (not an ES module) loaded via a blocking `<script src>` in
the `<head>` of all three pages (dashboard popup, full view, onboarding),
so it runs before first paint and seeds the `--theme-icon` custom property
from the saved preference (`liber_theme` in `localStorage`) or the OS
setting before anything renders. `window.LiberTheme.initToggle(button)`
wires a toggle button's click handler and keeps its accessible label in
sync; the actual color and icon swap is pure CSS, driven by `--theme-icon`
via a `@container style(...)` query in `_base.css`.

### `src/onboarding/` — First-run setup

`onboarding.html` is shown once on install (via `background.js`) and is also
registered as the extension's `options_page`. It collects name and
profession, saving them via `setProfile` on submit (`onboarding.js`), and
prefills the form if a profile already exists.

`onboarding.js` also sends `LIBER_LLM_WARMUP` unconditionally as soon as
its script runs (not gated on submit), preloading the model ahead of the
user's first apply click — silent, since the setup screen below is only
revealed after submit. This is the one deliberate exception to the
per-application flow's "never preload speculatively" rule above — a
distinct code path, not a contradiction. On submit, instead of a plain
confirmation message, it shows one of four state panels reflecting
`liber_llm_status` (live via `browser.storage.onChanged`): a progress bar +
"Downloading…"/"Almost ready…" line while loading; "Your job tracker is
ready." with an OK button once ready (`window.close()`s the tab — this tab
was opened via `browser.tabs.create()` by the extension itself, which is
exactly the case that's allowed to self-close); a friendly error message
with a Retry button (re-sends `LIBER_LLM_WARMUP`, which retries fresh since
`warmup()` clears its cache on `"error"`); or a friendly "can't finish on
this device" message with its own OK/Dismiss. None of this page's text
mentions "AI"/"model"/"WebGPU" — see `docs/roadmap.md`'s "Post-signup setup
page." If the status is already `"ready"` at submit time (fast connection,
or this page reused later as Options), the ready state shows immediately
with no loading flash. Closing the tab early doesn't cancel the load —
`warmup()`'s `enginePromise` lives in the Offscreen Document's own module
scope, independent of this page's lifetime.

## Data flow

Every trigger click captures exactly one snapshot and asks for consent
before anything is extracted or saved:

```
trigger click, not awaitingConsentResponse
     │
     │  countVisibleJobTitles() > 1?
     │     yes → resolveMultiJobScope(clickedEl)   (repetition detection + fallbacks)
     │     no  → resolveSingleJobScope(clickedEl)  (proximity to the click)
     │
     │  collectJobPostingLd() + collectPageText(scope)
     │  — synchronous, before the click's native action does anything
     ▼
renderConsentPopup("Save this job to your tracker?")
     │
     ├─ No  ──────────────────────────► nothing sent, nothing happens
     │
     └─ Yes ──► renderWorkingPopup(0) (local)
                   │
                   ▼
          LIBER_SAVE_REQUESTED { url, scopeText, structuredSnapshot }
                   │
                   ▼
     background.js: handleSaveRequested(tabId, ...)
                   │
                   ▼
     extractingTabs.add(tabId); LIBER_EXTRACTION_STATUS { phase: "working" } → tab
                   │
       structuredSnapshot complete? ──yes──► use it, skip the LLM
                    │ no
                    ▼
       urlExtractionCache hit? ──yes──► reuse cached snapshot
                    │ no
                    ▼
       llmEngine.extractJobFields(scopeText)  (→ offscreen.js → Worker → model)
                    │ (may throw LlmNotReadyError → showNotReadyPrompt)
                    ▼
       mergeSnapshot(structuredSnapshot, llmSnapshot) if structuredSnapshot was partial
                    │
                    ▼
       normalizeScrapedText() on every field, uniformly
                    │
                    ▼
       addJob(merged)  ── null = duplicate, else saved
                    │
                    ▼
       LIBER_EXTRACTION_STATUS { phase: "done", outcome } → tab
                    │
            delivered? ──no──► showSaveResultNotification (OS-notification fallback)
                    │
                    ▼
          maybeUnloadEngineAfter(tabId)  ── "unload immediately when done"
```

Every `logStep` call in `content.js` also sends a `LIBER_LOG` message,
independent of the pipeline above — `background.js` persists it via
`logStorage.appendLog`, and the dashboard's activity log re-renders via the
same `storage.onChanged` pattern, keyed on `liber_logs` instead of
`liber_jobs`.

## Data model

```js
// liber_jobs: Job[]
{
  id: string,
  company: string,
  jobTitle: string,
  jobDescription: string,  // always "" now — content.js no longer scrapes
                            // it; only jobTitle/company/location are
                            // captured since the flow refactor
  url: string,
  dateAdded: string,   // ISO timestamp
  status: "applied" | "interviewing" | "rejected" | "ghosted",
  location: string,
  notes: string,
}

// liber_profile
{
  name: string,
  profession: string,
}

// liber_llm_status, in browser.storage.session — see
// src/shared/llmStatus.js, written from src/offscreen/offscreen.js
{
  state: "idle" | "loading" | "ready" | "unsupported" | "error",
  progress: number,
  message: string,
}

// liber_logs, in browser.storage.session — see src/shared/logStorage.js;
// capped at the 200 most recent entries
Array<{
  tabId: number | null,
  url: string,
  step: string,
  detail: unknown,
  timestamp: number,
}>
```

There is no more per-tab persisted "attempt"/"candidate" record — the
previous two designs' `liber_candidate_<tabId>`/`liber_attempt_<tabId>`
session-storage records are gone entirely, since nothing in this design
needs state to survive beyond one in-memory async chain per accepted
click.

## Design notes: dedup key

`addJob` has one call site (`background.js`, on an accepted "Save this job
to your tracker?" prompt), and every call re-scrapes a live page — there's
no bulk import — so nothing stopped the same posting from being saved
twice if a user clicked "Apply" on it more than once.

The naive fix — compare the incoming job against every existing record
field-by-field — is an O(n) scan *per field comparison*, and gets worse the
more fields you check. The actual fix is cheaper: collapse each job down to
one composite string key and do set membership instead of comparison.
`jobTitle` + `company` + `location` was chosen as that key because, together,
they should uniquely identify one real posting — two genuinely different
jobs sharing all three is unlikely, whereas any one of them alone (e.g.
title) collides constantly ("Software Engineer" exists everywhere).

Two things had to be true for that key to actually work, both addressed
alongside the dedup check itself:

- **Normalization.** `jobTitle` comes back from `llmEngine.js`'s
  `extractJobFields`, already run through `normalizeScrapedText()` there,
  so casing/whitespace are already consistent by the time `addJob` sees it
  — but `buildJobKey` still independently lowercases, trims, and collapses
  whitespace on each part before joining them, so the key itself doesn't
  depend on that upstream normalization staying in place.
- **Fixing the data, not the key.** `addJob` falls back to
  `"Unknown company"` for a job with no detectable company. Keying on that
  placeholder directly would be wrong — two unrelated jobs with the same
  title and an undetected company would collide and the second would
  silently vanish. Rather than carve out a special case in the key (e.g.
  falling back to URL when company is a placeholder), the key stays simple
  and relies on extraction being thorough enough that `"Unknown company"`
  stays rare.

Cost-wise, `addJob` already calls `getAllJobs()` to get the array it's about
to `unshift` into — so building `new Set(jobs.map(buildJobKey))` from that
same array is the only extra work added. No second storage read, and the
whole dedup check stays O(n) with a plain hash lookup, same complexity class
`addJob` already had.

On a key collision, `addJob` returns `null` instead of inserting —
`handleSaveRequested` reports this back to the user as the `"duplicate"`
outcome rather than silently doing nothing.
