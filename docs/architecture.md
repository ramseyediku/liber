# Architecture

Liber is a Manifest V3 browser extension with no build step — the manifest
points directly at source files under `src/`, and `vendor/browser-polyfill.js`
provides the cross-browser `browser.*` API (so the same code runs on both
Chrome and Firefox) — except for scraping itself, which now requires WebGPU
(`src/shared/llmEngine.js`) and is Chrome/Chromium-only in practice; see
"Required LLM, no fallback" in the `background.js` section.

## Components

### `src/content/content.js` — Content script

Injected into every page (`<all_urls>`, `document_idle`). A single click
listener in the capture phase matches one pattern:

- `TRIGGER_PATTERN` (`/\b(apply|submit|next|continue|review)\b/i`) — covers
  both starting an application ("Apply"/"Submit") and continuing one
  already started ("Next"/"Continue"/"Review" — later steps use these
  words, not "Apply"). Word-boundary match on root words rather than a
  hardcoded phrase list, so new button phrasings ("Submit Your
  Application", "Quick Apply") work without adding a list entry, and `\b`
  keeps it from false-matching inside unrelated words like
  "resubmit"/"submitted". The content script runs on every page via
  `<all_urls>`, not just job sites, so a plain "Submit"/"Continue" button
  on an unrelated page (e.g. a checkout form) matches too — harmless, since
  `background.js`, not this pattern, decides whether a match actually
  starts or refines a tracked flow (see below), and a flow with nothing
  extractable near it never shows a prompt.

**The click itself is never blocked.** Earlier versions called
`event.preventDefault()` just long enough to guarantee a scope-capture
message was sent before navigation, then manually resumed the native
action afterward. That machinery is gone: nothing needs to happen
synchronously on the click anymore, since there's no click-time DOM
scoping left to do (see "Defer-and-watch scanning" below) — the native
action (navigation/form submission) always proceeds immediately.

Instead, every trigger click fires two things:

1. **An immediate "arming" message** — `LIBER_FLOW_STEP` with
   `scopeText: ""`, sent synchronously before anything else runs. This is
   the same no-op extraction path as a genuine "nothing found nearby"
   always was; its only real effect is to create/touch this tab's flow in
   `background.js` *before* anything can navigate away. That's what lets
   `background.js`'s `tabs.onUpdated` listener recognize "this tab is
   mid-flow" even after a real navigation destroys this content script
   entirely, or a click opens a brand-new tab whose own content script has
   no idea a click happened — see the `background.js` section below.
2. **`watchForStepChange()`**, which waits for the real single-job surface
   to actually appear, then collects and sends its text as a second,
   real `LIBER_FLOW_STEP`.

Every step of this process (trigger matched, listing check, scope
resolved, scope text collected) goes through `logStep(step, detail)`,
which both `console.log`s on the page (prefixed `"Liber: "`) and relays a
`LIBER_LOG` message to `background.js` for `logStorage.js` to persist —
so the dashboard's activity log (`src/dashboard/` section) can show it
live, not just whoever happened to have that page's own devtools open.
Every call also merges in `multipleListingsDetected` (per-click closure
state, from `countVisibleJobTitles() > 1`), so every log entry is
self-contained — it's informational/logged only now, and no longer gates
which scope-resolution strategy runs, since there's only one.

`countVisibleJobTitles()` counts distinct visible job titles anywhere on
the page via `JOB_TITLE_HINTS`. "Visible" means `isVisible()`'s
`document.elementFromPoint()` check — whatever's actually topmost at an
element's on-screen center point — not a layout/ARIA check
(`offsetParent`/`aria-hidden`/`inert`). The ARIA-based version shipped
first and broke on Indeed: its Easy Apply modal overlays the background
job list without hiding or `aria-hide`-ing it, so the layout check kept
seeing those cards as "visible" even at the final submit step.
`elementFromPoint` instead reflects the real stacking order — a modal's
backdrop sits on top of background content in virtually every real
implementation regardless of whether the site marks it `aria-hidden` — so
this works without needing the site's cooperation. See `docs/roadmap.md`
for that history.

### Defer-and-watch scanning (replaces click-time card scoping)

The previous design resolved a bounded DOM scope *synchronously, at click
time*, because the old field extractor needed a tightly-bounded region to
make sense of: on a multi-listing page it walked up to the specific
repeated card clicked (`findCardScope`), or — for master-detail layouts —
whichever list item was marked active (`findActiveCardScope`), gated on
`multipleListingsDetected` so that false-positive-prone card walking never
ran on an actual single-job page.

That's gone. Now that extraction is an on-device LLM that can read
arbitrary page text, click-time precision isn't needed — it's simpler and
more reliable to let the click happen normally, wait for the real
single-job surface to appear (a modal, or the page settling after an
in-place step change), and scan *that* instead of trying to guess which
card a click belonged to while a list is still on screen:

- `findVisibleDialog()` — checks `[role="dialog"], [aria-modal="true"],
  dialog` (via `isVisible()`), then falls back to a generic
  overlay heuristic (visible, `position: fixed`/`absolute`, `z-index >=
  100`, covering ≥30% of the viewport) for modals built without ARIA
  semantics. A heuristic, with the same accepted false-positive/negative
  risk as `isVisible()` itself (e.g. a large promo banner could
  theoretically qualify; a small corner toast won't).
- `resolvePageScope()` = `findVisibleDialog() || document.querySelector('form,
  main, [role="main"], article') || document.body` — the page-wide,
  anchor-less replacement for the old landmark fallback (there's no
  "clicked element" to walk up from anymore by the time this runs).
- `collectPageText(scope)` — same bounded/whitespace-collapsed/
  `SCOPE_TEXT_MAX_LENGTH`-capped `.innerText` read as before, just not
  anchored to a clicked element.
- `watchForStepChange()` — a `MutationObserver` on `document.body`,
  throttled, resolves as soon as `findVisibleDialog()` finds something. If
  neither a modal nor a page navigation happens within `SETTLE_WINDOW_MS`
  (2.5s) — e.g. a "step 2 of 4" wizard that swaps its form content in
  place with no dialog at all — it resolves with `resolvePageScope()`
  instead, so a non-modal in-place step change still gets scanned. A
  `pagehide` listener resolves with `null` if the page is actually
  navigating away; the destination page is covered by `background.js`'s
  `tabs.onUpdated` listener instead (see below), not by this one.

Only `jobTitle`/`company`/`location` are captured — the LLM prompt
(`llmEngine.js`) only asks for these three fields. See `docs/roadmap.md`
for `jobDescription`'s status.

### Field extraction, off content.js

`content.js` never resolves `jobTitle`/`company`/`location` itself — it
just ships plain scope text to `background.js`, which turns it into those
three fields using an on-device LLM (`src/shared/llmEngine.js`, see below).
An LLM reads the same bounded text as a human would, so it doesn't depend
on a site exposing any particular markup/attribute convention — the
tradeoff is "can the model find job title/company/location in whatever
text is actually there?" rather than "does this site expose the right
attribute?". See `docs/roadmap.md` for the limitations this doesn't remove
(model/device requirements, latency, and the new failure modes an LLM
introduces that a regex never could).

### `src/shared/llmEngine.js` — On-device field extraction

Turns bounded scope text into `{jobTitle, company, location}` using
[WebLLM](https://github.com/mlc-ai/web-llm) (`vendor/web-llm.js`, a
vendored, minified ESM build — same no-build-step reasoning as
`vendor/browser-polyfill.js`), running a small local model
(`Qwen2.5-0.5B-Instruct-q4f16_1-MLC`, ~945MB) entirely on-device via
WebGPU. No network call happens per extraction — only the one-time model
weight download, fetched and cached by WebLLM itself. See
`docs/roadmap.md`'s "Model size vs. accuracy" for why this specific
size/model was picked over WebLLM's other prebuilt options, and what to do
if extraction accuracy turns out unreliable at this size.

This module only ever runs inside `background.js`'s service worker — never
in a content script. Content scripts run once per tab on `<all_urls>`;
loading a multi-gigabyte model into every tab would be impossible. The
service worker is the one shared, privileged context, and WebGPU is
reachable from an MV3 service worker's global scope (Chrome added this
specifically to support in-extension ML, stable since Chrome 124) — so the
engine lives there, and `background.js` calls it directly rather than
through a separate client/handler split (that split exists in WebLLM for
when a *different* context needs the engine; here the one context that
calls it is the one that hosts it).

- `warmup()` — lazily creates the singleton `MLCEngine` via WebLLM's
  `CreateMLCEngine`, wiring its progress callback into `llmStatus.js`.
  Idempotent: safe to call from multiple places (`onInstalled`,
  `onStartup`, and the onboarding page's post-submit message) without
  triggering a second download. On failure, clears its cached promise so
  the *next* call retries instead of staying permanently rejected.
- `extractJobFields(scopeText)` — the only other export. Checks
  `navigator.gpu` support, then calls `engine.chat.completions.create`
  with a short system prompt and `response_format: { type: "json_object",
  schema }` — WebLLM's grammar-constrained JSON mode, which guarantees
  well-formed `{jobTitle, company, location}` output instead of the old
  approach's best-effort regex matching. The prompt explicitly instructs
  the model to return `""` for anything not found rather than guess, to
  keep the model's failure mode "field left blank" rather than
  hallucinated data. Each field is run through
  `normalizeScrapedText()` (moved to `src/shared/textNormalize.js`, since
  this is now its only caller) for the same whitespace/title-case cleanup
  the old matcher's output got. Throws `LlmNotReadyError` — carrying the
  current `llmStatus` — if the engine isn't ready; callers never fall back
  to any other extraction method (see "Required LLM, no fallback" below).

**MV3 service-worker suspension.** The engine lives in module-level state,
which is lost whenever Chrome suspends the service worker (after ~30s
idle) or the browser restarts — the next call has to re-create the engine.
WebLLM caches the downloaded weight files via the Cache API, so this is a
reload (re-instantiating WASM and re-uploading weights to the GPU), not a
re-download, but it still costs a few seconds. Not solved here — see
`docs/roadmap.md`.

### `src/shared/llmStatus.js` — Shared model-load status

One session-backed record (`liber_llm_status`, mirroring `logStorage.js`'s
single-shared-key shape) — `{ state: "idle" | "loading" | "ready" |
"unsupported" | "error", progress, message }`. Written by `llmEngine.js`'s
progress callback; read by `onboarding.js` and
`dashboard-core.js` (both via the same `browser.storage.onChanged` pattern
already used for jobs/logs) to show a live "Setting up on-device AI… 42%"
/ "Ready" / "Unsupported browser" status.

### `src/background/background.js` — Background service worker

The central coordinator for the per-tab apply flow, persisted in
`browser.storage.session` via `src/shared/flowStorage.js` (not an in-memory
`Map` — that wouldn't survive an MV3 service-worker restart between the
apply click and the notification click, which was a latent bug in an
earlier version). One flow record per tab:

```js
// liber_flow_<tabId>
{
  status: "pending" | "captured",
  snapshot: { jobTitle, company, location } | null,
  savedJobId: string | null,   // set once "Save to Liber" is clicked
  dismissed: boolean,          // set once "Dismiss" is clicked
  createdAt: number,
  lastUpdatedAt: number,       // used for lazy TTL expiry and the
                                // tabs.onUpdated "is this flow still
                                // active" check, see below
  lastScannedUrl: string,      // set by the cross-navigation/cross-tab
                                // scan below, so a tab already scanned at
                                // its current URL isn't rescanned on an
                                // unrelated tabs.onUpdated event
}
```

Responsibilities:
- On first install, opens the onboarding page and calls `warmupAndNotify()`
  (below) so the model starts downloading/loading immediately, rather than
  on the first apply click. `browser.runtime.onStartup` calls it too, for
  the "already installed, just reopened the browser" case — module-level
  state (and so the engine singleton) doesn't survive a full browser
  restart, only `onInstalled`'s install/update firing.
- `LIBER_LLM_WARMUP` → calls `warmupAndNotify()`; sent by `onboarding.js`
  right after the profile is saved, and by `dashboard-core.js` every time
  either dashboard page opens, so the download gets started/nudged forward
  as early and as often as possible — including resuming one that stalled
  because MV3 suspended the service worker mid-download while nothing else
  happened to call `warmup()` again.
- `warmupAndNotify(​)` wraps `llmEngine.js`'s `warmup()` with a one-time
  "Liber's on-device AI is ready" notification the first time the returned
  promise resolves successfully. Guarded two ways: a module-level
  `readyNotificationAttached` flag stops multiple call sites in the same
  service-worker lifetime from each attaching their own completion handler
  to the same (cached) `warmup()` promise, and a persistent flag
  (`storage.js`'s `hasNotifiedLlmReady`/`markLlmReadyNotified`, in
  `storage.local` rather than session storage) stops it from firing again
  after a *later* service-worker restart resolves the same promise a
  second time from a cache-warm reload. Added after real first-install
  testing showed the model download (even at the current, deliberately
  small, model size — see `docs/roadmap.md`'s "Model size vs. accuracy")
  can take long enough on a slow connection that a purely passive status
  chip isn't enough; this actively tells the user once it's actually usable
  instead of requiring them to keep checking back.
- `LIBER_LOG` → persists the entry via `logStorage.js`'s `appendLog`
  (fire-and-forget; a logging call must never block or fail the scrape
  it's reporting on).
- `LIBER_FLOW_STEP` → delegates to `handleFlowStep(tabId, scopeText)`, the
  single funnel point every scan path (content.js's arming/real-scan
  messages, and background.js's own cross-navigation/cross-tab scans
  below) feeds through. It first resolves `scopeText` into a `snapshot`
  via `llmEngine.js`'s `extractJobFields` (skipped, snapshot `null`, if
  `scopeText` itself was empty — covers both content.js's arming message
  and a genuine "nothing found" case, neither of which is a not-ready
  signal). If extraction throws `LlmNotReadyError`, shows a one-per-tab
  "Liber can't scrape this application yet" notification describing *why*
  and returns without touching flow state. No other fallback: a deliberate
  choice (see "Required LLM, no fallback" below), not an oversight.

  Once a `snapshot` exists (or is confirmed empty), looks up the tab's flow
  and branches on whether one already exists — this is the single place
  that decides "start" vs. "refine", not content.js:
  - **No flow yet (starting one):** a complete snapshot
    (`isComplete(snapshot)` — `jobTitle && company && location` all
    truthy) stores `status: "captured"` and shows the "Save this job
    application?" notification immediately. An incomplete one (including
    content.js's empty-scopeText arming message, almost always the first
    message for a new flow) stores `status: "pending"` with whatever
    partial snapshot it has, and shows nothing yet.
  - **A flow already exists (refining one):** a falsy `snapshot` still
    touches the flow (`setFlow(tabId, flow)`, unchanged) purely to refresh
    `lastUpdatedAt` — otherwise an arming-only click on an already-started
    flow would never count as "recent activity" for the `tabs.onUpdated`
    check below. A real `snapshot` merges into the stored one via
    `mergeSnapshot` (`src/shared/fieldMerge.js`), logging any genuine field
    conflicts via `console.warn`. If the flow was still `"pending"` and
    the merged snapshot is now complete, promotes it to `"captured"` and
    shows the prompt — **only once all three fields are known**, not as
    soon as the first one is (the previous behavior). Otherwise updates the
    stored snapshot silently — and, only once `"captured"`, either updates
    the already-saved row (`updateJob`, if `savedJobId` is set) or
    refreshes the still-open notification's text (`notifications.update`,
    if not yet saved/dismissed).
- **`browser.tabs.onUpdated`** — covers the two cases content.js's own
  in-page `watchForStepChange()` structurally cannot observe: a real
  same-tab page navigation (content.js's instance on the pre-navigation
  page is gone by the time the new page loads) and a brand-new tab (whose
  content.js has no idea a click happened anywhere). Fires on every tab's
  `status: "complete"`, across the whole browser — cheap to no-op on,
  since it starts with a `getFlow(tabId)` read and returns immediately if
  there's no flow for that tab. When there is:
  - If the tab has no flow of its own but `tab.openerTabId` does (and that
    opener's flow was touched within `RECENT_FLOW_WINDOW_MS`, 2 minutes),
    the opener's flow is copied onto this tab via `flowStorage.copyFlow` —
    this is how an ATS redirect to a brand-new tab/domain inherits the
    flow. `tab.openerTabId` being available right on the `tab` argument is
    what lets one listener cover both the same-tab and new-tab cases; no
    separate `tabs.onCreated` listener is needed.
  - A flow untouched for longer than `RECENT_FLOW_WINDOW_MS`, or already
    scanned at this exact URL (`flow.lastScannedUrl === tab.url`), is
    skipped.
  - Otherwise, injects `liberScanInjectedPage` via
    `browser.scripting.executeScript` (manifest already grants `scripting`
    + `<all_urls>`, so no `activeTab` gesture is needed) to collect that
    page's text, records `lastScannedUrl`, and feeds the result through
    `handleFlowStep` — the same pipeline as everything else. A restricted
    page (`chrome://`, the Web Store, a PDF viewer) throws on injection and
    is silently skipped.
  - `liberScanInjectedPage` is a self-contained top-level function (it
    can't `import` anything — `executeScript`'s `func` has to be
    self-contained) that duplicates a small, deliberately narrower slice of
    content.js's `findVisibleDialog`/`resolvePageScope`: no
    overlay-heuristic fallback, no `countVisibleJobTitles`, no
    `MutationObserver`/settle-window, since a one-shot scan right after
    `status: "complete"` already waited for the page to load.
- On notification button click: "Save to Liber" → `addJob(flow.snapshot)`,
  then keeps the flow record around (doesn't clear it) with `savedJobId`
  set, so a later refine can still update that row instead of re-prompting.
  "Dismiss" → keeps the flow around too, marked `dismissed`, so later
  refinements still update the stored snapshot without showing the prompt
  again.
- **`browser.tabs.onRemoved`** — if the tab's flow never reached
  `isComplete()` (e.g. a site that never exposes location) but did collect
  *some* real data, and wasn't dismissed, this promotes it to `"captured"`
  and shows the save prompt as a last resort rather than silently losing a
  real application over one missing field — the old "prompt on any field"
  behavior, now scoped specifically to "the tab closed, so this flow is
  genuinely over." The flow isn't cleared in that case (the notification
  button handler still needs `getFlow(tabId)` to work); the existing 30-min
  TTL cleans it up if the notification's never clicked. A flow that goes
  stale via that TTL *while its tab stays open* gets no such fallback — MV3
  has no persistent timer to drive that proactively; accepted, since
  tab-close is the common, concrete "this flow is really over" signal.
  Otherwise, the flow is cleared immediately as before. Either way,
  `flowStorage.getFlow` also lazily expires (and deletes) any flow
  untouched for 30 minutes, so an abandoned flow doesn't linger forever
  without needing a persistent timer (which wouldn't survive
  service-worker suspension in MV3 anyway).
- Answers `CHECK_ONBOARDED` messages by checking `isOnboarded()`.

**Required LLM, no fallback.** There's no path back to the old synonym
matcher — if WebGPU/the model isn't available, Liber shows the "not ready"
notification above rather than silently degrading to a worse extraction
method. This was a deliberate choice over keeping both: scraping is now
Chrome/Chromium-only (WebGPU support on Firefox is still inconsistent, so
despite `manifest.json` still shipping `browser_specific_settings.gecko`,
the extraction path doesn't work there today) rather than maintaining two
extraction strategies indefinitely. See `docs/roadmap.md`.

### `src/shared/flowStorage.js` — Ephemeral per-tab flow state

Parallels `storage.js`'s wrapping of `storage.local`, but for
`storage.session` — a flow shouldn't survive the browser restarting the
way a saved job should. One storage key per `tabId` (`liber_flow_<tabId>`,
not one shared object all tabs read/write), which is what makes two tabs'
flows structurally unable to race on the same key.

`copyFlow(fromTabId, toTabId)` — a literal snapshot copy under the new
tab's key, not a live shared reference, keeping that same one-key-per-tabId
guarantee. Used by `background.js`'s `tabs.onUpdated` listener to carry a
flow into a brand-new tab opened mid-application (e.g. an ATS redirect to a
separate domain) — see the `background.js` section above.

### `src/shared/logStorage.js` — Rolling scraping-activity log

Also backed by `storage.session` (debugging data, not something that needs
to survive a browser restart) — but one shared list (`liber_logs`), not
per-tab, since the dashboard shows it page-wide across however many tabs
logged to it. `appendLog(entry)` pushes a `{ ...entry, timestamp }` and caps
the list at the most recent 200 entries (`getLogs`/`clearLogs` round it
out). Fed by `background.js`'s `LIBER_LOG` handler, which is in turn fed by
`content.js`'s `logStep` — see both sections above.

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
caller to log.

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
- `hasNotifiedLlmReady` / `markLlmReadyNotified` — the one-time "model
  ready" notification's persistence (see `background.js`'s
  `warmupAndNotify`), keyed under `liber_llm_ready_notified`. Deliberately
  here rather than in `llmStatus.js` — this needs to survive a browser
  restart (so the notification genuinely fires once ever, not once per
  service-worker lifetime), unlike everything else `llmStatus.js` tracks.

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

The full view only (not the popup) also renders a "Scrape Activity Log"
panel below the table/pagination — `renderLogs()` reads `logStorage.js`'s
rolling buffer and lists entries newest-first (time, page hostname, step,
pretty-printed detail dict), with a "Clear" button (`clearLogs`). Nothing
is truncated — a long detail wraps onto as many lines as it needs rather
than being hidden behind an ellipsis, so the list's own scroll (reached by
scrolling past earlier messages) is the only scrolling. The same
`browser.storage.onChanged` listener re-renders it live whenever
`liber_logs` changes, so it updates in step with `content.js`'s scraping as
it happens — no reload needed.

Both pages also render a small `liber_llm_status`-driven chip
(`renderLlmStatusChip`, `#llm-status-chip` — present on both templates, not
full-view-only like the activity log), live-updated the same
`browser.storage.onChanged` way. `initDashboard()` also sends a
`LIBER_LLM_WARMUP` message on load — not just reading the status, but
actively nudging `background.js`'s `warmupAndNotify()` — so opening either
page can resume a load that stalled (e.g. the service worker got suspended
mid-download) without the user having to click Apply or reopen onboarding.

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

## Data flow

```
trigger clicked
     │
     │  LIBER_FLOW_STEP { scopeText: "" }   ──(arming message, synchronous, no preventDefault)
     ▼
handleFlowStep(tabId, "") → snapshot: null → flow stored/touched as "pending"
     │
     │  watchForStepChange() resolves (modal appears, or SETTLE_WINDOW_MS elapses)
     ▼
LIBER_FLOW_STEP { scopeText: <dialog/landmark text> }
     │
     ▼
handleFlowStep(tabId, scopeText)
     │
     ▼
llmEngine: extractJobFields(scopeText) → snapshot, or throws LlmNotReadyError
     │ (not-ready → "not ready" notice, flow state untouched, return)
     ▼
flowStorage: getFlow(tabId)
     │
     ├─ no flow ───────────────► isComplete(snapshot)?
     │                              │ yes → setFlow("captured") → notifications.create (save prompt)
     │                              │ no  → setFlow("pending", partial snapshot)
     │
     └─ flow exists ───────────► fieldMerge: mergeSnapshot(flow.snapshot, snapshot)
                                    │
                                    ├─ now complete & still "pending" → setFlow("captured")
                                    │    → notifications.create (save prompt, now — not on first field)
                                    └─ otherwise → setFlow(merged) silently;
                                         "captured" only → updateJob() if saved, else
                                         notifications.update() to refresh the open prompt
     │
     │  user clicks "Save to Liber"
     ▼
storage.js: addJob() → browser.storage.local
     │
     ▼
dashboard.js (storage.onChanged listener) → re-render table
```

Same-tab navigation and brand-new tabs feed the same `handleFlowStep`
pipeline from a different entry point — `background.js`'s `tabs.onUpdated`
listener, triggered by that tab reaching `status: "complete"` rather than
by a message from content.js:

```
tab reaches status: "complete"
     │
     ▼
flowStorage: getFlow(tabId) → none, but tab.openerTabId has a recent flow?
     │
     ▼ (new-tab case only)
flowStorage: copyFlow(openerTabId, tabId)
     │
     ▼
flow recent enough (< RECENT_FLOW_WINDOW_MS) and not already scanned at this URL?
     │
     ▼
scripting.executeScript(liberScanInjectedPage) → { text }
     │
     ▼
setFlow({ ...flow, lastScannedUrl: tab.url })
     │
     ▼
handleFlowStep(tabId, text)   ── same pipeline as the diagram above
```

Note `scopeText`/`snapshot` resolution happens entirely inside
`background.js` — content.js (and the injected cross-navigation scanner)
only ever sends/returns raw text; neither computes or sees a `snapshot`
itself (see "Field extraction, off content.js" above).

Every `logStep` call in `content.js` also sends a `LIBER_LOG` message,
independent of the flows above — `background.js` persists it via
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

// liber_flow_<tabId>, in browser.storage.session — see
// src/shared/flowStorage.js and the background.js section above
{
  status: "pending" | "captured",
  snapshot: { jobTitle: string, company: string, location: string } | null,
  savedJobId: string | null,
  dismissed: boolean,
  createdAt: number,
  lastUpdatedAt: number,
}

// liber_profile
{
  name: string,
  profession: string,
}

// liber_llm_status, in browser.storage.session — see
// src/shared/llmStatus.js and the llmEngine.js section above
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

## Design notes: dedup key

`addJob` has one call site (`background.js`, on "Save to Liber"), and every
call re-scrapes a live page — there's no bulk import — so nothing stopped
the same posting from being saved twice if a user clicked "Apply" on it more
than once.

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
  stays rare. Scope is still narrow here, same as before this change —
  extraction only ever looks at text near the clicked anchor, never the
  whole page, so an undetected company is still more likely on a site with
  sparse nearby content than it would be with a page-wide fallback.

Cost-wise, `addJob` already calls `getAllJobs()` to get the array it's about
to `unshift` into — so building `new Set(jobs.map(buildJobKey))` from that
same array is the only extra work added. No second storage read, and the
whole dedup check stays O(n) with a plain hash lookup, same complexity class
`addJob` already had.

On a key collision, `addJob` returns `null` instead of inserting. There's
currently no UI feedback for that — see `roadmap.md`.
