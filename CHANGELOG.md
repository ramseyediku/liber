# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - Unreleased

### Added
- `src/offscreen/offscreen.html`/`offscreen.js`/`llmWorker.js` — the
  on-device model now runs in a real Worker, hosted inside a
  `chrome.offscreen` Document rather than directly in the background
  service worker (a literal `new Worker()` created inside an MV3
  extension service worker isn't supported). `src/shared/llmEngine.js` is
  now a thin RPC shim over this Offscreen Document; its exported API
  (`warmup`/`extractJobFields`/`unloadEngine`/`LlmNotReadyError`) is
  unchanged. New `"offscreen"` permission in `manifest.json`.
- Click-time card detection on listings pages (`content.js`'s
  `resolveMultiJobScope`/`findRepeatedCardAncestor`) — finds the specific
  repeated card an Apply click happened inside via structural repetition
  detection (same tag, overlapping class list), instead of skipping
  listings pages entirely. Single-job pages now scope to the container
  around the clicked element specifically
  (`resolveSingleJobScope`), not just the nearest landmark anywhere in the
  document.
- A consent-first apply-capture flow: a trigger click captures one
  snapshot and asks "Save this job to your tracker?" immediately, before
  touching the model at all. Only on "yes" does extraction (JSON-LD first,
  the LLM only if still incomplete) and saving happen, reported back as a
  plain "Job saved. You can check it in your table."/duplicate/failed
  result — no field preview, since nothing's extracted at prompt time.

### Changed
- **The entire apply-capture flow is replaced again** — this time
  dropping automatic "has the user finished applying?" detection
  entirely, in favor of asking directly. Every prior design (incremental
  per-step extraction, capture-at-submit, multi-step capture with
  continuation-signal detection) needed increasingly fragile machinery
  (grace timers, continuation signals, cross-tab carryover,
  reload-vs-dialog heuristics tuned per-ATS) to approximate one question
  the user can just answer. See `docs/roadmap.md`'s "Capture flow
  rewrite: single-click, consent-first" for the full history and
  tradeoffs.
- `warmup()` is now strictly lazy for the per-application flow — never
  called speculatively on a captured step anymore, only once the user has
  actually accepted the consent prompt. `onboarding.js`'s own unconditional
  page-load preload is unchanged (a separate, deliberate early-preload for
  first-time setup).

### Removed
- `src/shared/attemptStorage.js` and `src/shared/snapshotResolution.js`
  (plus its test) — no per-tab persisted state survives across a capture
  anymore; each accepted consent prompt is one bounded async chain that
  runs to completion independent of tab lifecycle, with the JSON-LD-then-
  LLM-if-needed merge (~6 lines) inlined directly into `background.js`'s
  `handleSaveRequested`.
- All continuation-detection machinery: `watchForContinuation()` and the
  `history.pushState`/`replaceState`/`popstate` patch in `content.js`;
  `markContinuation`/`commitAttempt`/`carryOverAttempt`, the
  `tabs.onUpdated`/`tabs.onCreated` listeners, and the
  `EXTRACTION_GRACE_MS`/`CARRYOVER_WINDOW_MS` timers in `background.js`.
- The on-page results popup's field preview (Title/Company/Location rows)
  — there's nothing to preview at consent time anymore, since extraction
  hasn't run yet.
- The OS-notification Save/Dismiss buttons (`notifications.onButtonClicked`)
  — consent already happens in-page before any notification fallback could
  fire, so there's no decision left for notification buttons to make; the
  fallback is now a plain report.

### Added
- `src/shared/snapshotResolution.js` — `resolveAttemptSnapshot`, walking a
  multi-step attempt's accumulated captures earliest-first (JSON-LD before
  the LLM, per step), short-circuiting the moment `jobTitle`/`company`/
  `location` are all known. Unit-tested (`snapshotResolution.test.js`).
- `src/shared/attemptStorage.js`'s `copyAttempt` — carries a multi-step
  attempt's accumulated steps forward into a brand-new tab (e.g. an ATS
  redirect), replacing the previous design's flat discard.

### Fixed
- `countVisibleJobTitles()` (`content.js`) could wrongly flag the real
  final step of an application as "still a listings page" and skip it
  entirely (no capture, no continuation check), permanently stalling that
  attempt. Cause: the "broad" job-title hints (`position`/`role`) are
  substring-matched against `id`/`class`/`data-testid`/`aria-label`,
  which also matches a real application form's own fields ("Current
  role", "Desired position") — now excludes `input`/`select`/
  `textarea`/`label`/`button` elements from the match.
- `watchForContinuation()`'s SPA soft-navigation detection
  (`content.js`) treated every `history.replaceState` call as a sign the
  application was continuing, including routine SPA bookkeeping
  unrelated to an actual step change (scroll-position syncing, analytics
  view tracking) — one of those landing near a genuine final click would
  wrongly mark it as "still continuing" forever. `replaceState` now only
  counts as a signal if `location.pathname` actually changed;
  `pushState` is unaffected (still unconditional).
- `background.js`'s `markContinuation` treated a same-tab page reload as
  "still continuing" unconditionally, at every step — but some ATS flows
  (e.g. Indeed's `smartapply.indeed.com`) reload the page on *every*
  step, including the genuinely final one, so the attempt could never be
  detected as done at all on that kind of site. A reload now only blocks
  the commit right after the very first captured step; past that, only a
  dialog or a new tab still do. `handleCaptureStep` also now carries the
  accumulated `steps` forward from a `"ready"` attempt (not just
  `"capturing"`), since a commit can fire earlier now while the user is
  still genuinely continuing — without this, that next capture would
  have thrown away everything already accumulated.

### Changed
- **Capture moved from once-at-final-submit back to every trigger click,
  while extraction still only runs once per application.** Every
  Apply/Submit/Next/Continue/Review click on a single-job page now
  captures that step's page content and appends it to a growing,
  per-attempt list (`src/shared/attemptStorage.js`'s `attempt.steps`,
  replacing the previous single-candidate `scopeText`/`structuredSnapshot`
  shape) instead of only capturing on the one click matching the old
  `FINAL_SUBMIT_PATTERN` (now deleted — every trigger click behaves the
  same way). This fixes a real regression the previous (just-shipped)
  design introduced: capturing only the final step regularly missed the
  job title/company/location entirely, since that information is often
  only visible on the original job-listing page or an earlier step, not
  on a late-stage, form-only step. Extraction itself still only ever runs
  once per application, at commit time — `src/shared/snapshotResolution.js`'s
  `resolveAttemptSnapshot` walks the accumulated steps earliest-first and
  stops the moment a complete snapshot is found, so the LLM may run on
  zero, one, or (at most) a few of the captured steps, never all of them
  speculatively. See `docs/architecture.md`'s "Multi-step capture,
  commit-on-true-finality" and `docs/roadmap.md`'s "Capture flow rewrite:
  multi-step capture" for the full design and its tradeoffs.
- **Continuation detection gained two new signals.** In addition to the
  existing in-page dialog watch, `content.js` now also treats an SPA
  soft-navigation (`history.pushState`/`replaceState`/`popstate`) as a
  sign the flow is continuing, not finished — many ATS wizards move
  between steps via client-side routing with no dialog at all.
  `background.js` gained a new `tabs.onUpdated` listener to catch a real
  same-tab top-level reload, which a content-script instance can't
  reliably watch for itself since it may not survive the navigation; this
  does **not** bring back the `scripting` permission or any injected
  cross-navigation re-scan — it's purely a "don't commit yet" signal.
- **Cross-tab continuation carries data forward again.** A new tab opening
  from a tab with an in-progress attempt (e.g. an ATS redirect) now copies
  the accumulated steps into the new tab (`attemptStorage.js`'s new
  `copyAttempt`, via `background.js`'s `carryOverAttempt`) and clears the
  opener's own copy, instead of discarding them — reversing the previous
  design's "new tab starts fresh" tradeoff, now that losing an earlier
  step's captured job info is a real, demonstrated cost rather than a
  theoretical one.
- `src/shared/candidateStorage.js` is renamed `src/shared/attemptStorage.js`
  (`getCandidate`/`setCandidate`/`clearCandidate` → `getAttempt`/
  `setAttempt`/`clearAttempt`; status `"awaiting-finality"` →
  `"capturing"`) to match the new list-based shape — the same kind of
  rename this module went through once before (`flowStorage.js` →
  `candidateStorage.js`) when its underlying data model last changed
  shape.
- `background.js`'s `tabs.onRemoved` now commits a still-`"capturing"`
  attempt immediately when its tab closes, instead of leaving it alone.
  Needed because an attempt can now wait indefinitely after a
  continuation signal (e.g. a same-tab redirect to a "thank you for
  applying" confirmation page with no further trigger element) — without
  this, a real completed application whose tab gets closed right after
  would otherwise silently expire via the 30-minute TTL instead of ever
  being extracted/saved.

### Removed
- `FINAL_SUBMIT_PATTERN` and `content.js`'s silent-warmup-only path
  (`requestSilentWarmup`) — every trigger click now captures the same
  way, so there's no longer a behavioral split to gate on. Warming up the
  model is now just a side effect of `background.js`'s `handleCaptureStep`
  (called on every captured step; `warmup()` is already idempotent).

### Added
- On-page "doing some work" / results popup (`content.js`), shown only
  after a genuine final submit click — progress bar while extraction runs,
  then the extracted fields with Save/"Not now" buttons. Replaces the
  native-notification confirm flow as the primary UI; the notification is
  now only a fallback for when the popup can't be delivered (tab closed,
  or a restricted page).
- `src/shared/candidateStorage.js` — per-tab extraction-candidate storage
  replacing `flowStorage.js`, matching the new one-shot-at-submit model
  (`awaiting-finality` → `extracting` → `ready` → `saved`/`dismissed`).

### Changed
- **Extraction moved from incremental-per-step to once-at-final-submit.**
  Previously, every Apply/Next/Continue/Review click could trigger an LLM
  call. Now, a click is split into three outcomes: still a listings page
  (nothing happens), a "Next"/"Continue"/"Review" click (silently nudges
  the model to preload, no capture), or a genuine "Submit"/"Apply" click
  (captures the page synchronously, then commits as final only if nothing
  — a dialog in the same tab, or a new tab opening — signals the flow is
  actually continuing). This moves the LLM's real, user-visible slowdown
  out of the mid-fill steps and into the natural pause after the user has
  already finished. See `docs/architecture.md`'s "Capture-at-submit" and
  `docs/roadmap.md`'s "Capture flow rewrite: capture-at-submit" for the
  full design and its tradeoffs (notably: a narrower `FINAL_SUBMIT_PATTERN`
  than the old `TRIGGER_PATTERN`, and the loss of incremental field-merging
  across steps).
- The LLM engine is now unloaded immediately after every extraction
  finishes (success or failure), not just on the idle timer or flow
  completion/abandonment — each candidate only ever runs extraction once
  now, so there's no reason to keep it warm afterward.
- Cross-tab continuation (an ATS redirect to a brand-new tab) no longer
  carries any captured data forward (`flowStorage.js`'s old `copyFlow` is
  gone) — a new tab opening from one with a pending candidate just
  supersedes (discards) that candidate, and independently captures and
  commits its own eventual final click. Simpler, and loses nothing under
  the new one-shot-per-application model.
- `llmStatus.js` no longer broadcasts status to every open tab — only
  `onboarding.js` (via `storage.onChanged`) and `background.js` itself
  (to relay live loading progress into the new per-tab
  `LIBER_EXTRACTION_STATUS` push) read it now that `content.js`'s old
  generic progress badge is gone.
- `manifest.json` no longer requests the `scripting` permission — it was
  only used by the cross-navigation re-scanner this rewrite removes.

### Removed
- `src/shared/flowStorage.js` and the incremental per-step field-merge
  pipeline it backed (`background.js`'s old `handleFlowStep`,
  `tabs.onUpdated`'s cross-navigation `liberScanInjectedPage` scanner) —
  replaced by `candidateStorage.js` and the capture-at-submit pipeline
  above. `fieldMerge.js` itself is kept (still used once per candidate, to
  merge partial JSON-LD with the LLM's output), just no longer used
  incrementally across steps.
- `content.js`'s on-page model-loading progress badge (the plain
  `ensureBadgeEl`/`renderBadge` div track/fill, driven by a broadcast
  `LIBER_LLM_STATUS` message) — superseded by the richer post-submit
  extraction popup above, which only appears once there's something
  concrete to show.


- Content script that detects "Apply" / "Submit" clicks and scrapes job
  title, company, location, and description, with platform-specific
  selectors for LinkedIn and Indeed and a generic fallback.
- Background service worker that prompts for confirmation via a browser
  notification and saves confirmed jobs to local storage.
- Dashboard popup listing tracked jobs with editable status and notes, and
  live re-render on storage changes.
- Full-view dashboard page (sidebar, every column) opened in a new tab from
  the popup, sharing its table-rendering logic with the popup.
- Dark/light theme toggle (`src/shared/theme.js`), available on the popup,
  full view, and onboarding pages, with the preference saved to
  `localStorage` and seeded before first paint.
- Onboarding page shown on first install, collecting name and profession.
- Shared storage module (`src/shared/storage.js`) wrapping
  `browser.storage.local` for jobs and profile data.
- Collapsible sidebar on the full-view dashboard — state persists across
  visits via `localStorage`, same as the theme preference.
- Profile popover (name + profession) opened from the avatar button, on
  both the popup and full view.
- Apply-click sound effect (`src/assets/notif.mp3`, exposed via
  `web_accessible_resources`) for instant feedback when a job is detected,
  played from the content script rather than the confirmation notification
  — see `roadmap.md` for why.
- Duplicate-job detection in `addJob()` (`src/shared/storage.js`): a job is
  skipped (not re-saved) if its normalized `jobTitle` + `company` +
  `location` already matches an existing record. See "Design notes: dedup
  key" in `docs/architecture.md` for the reasoning.
- Company-extraction fallbacks in `content.js` — known-ATS URL slug
  (Lever/Greenhouse/Workday/SmartRecruiters/Ashby/BambooHR), page-wide
  `Organization` JSON-LD, and the non-title segment of `document.title` —
  tried before falling back to "Unknown company", so the dedup key above is
  less likely to collide on an unidentified company.
- Slide-in detail panel on the full-view dashboard for viewing/editing a
  single application — opened by clicking its table row, it shows the job
  title as its heading with status (a segmented control, highlighted in
  accent), company/location/date, and a note field, plus Prev/Next buttons
  that page across the whole job list (not just the current table page) and
  a delete action. Stays in sync with storage changes and pagination via
  the same `renderJobs()` pipeline the table already used.
- `normalizeScrapedText()` in `content.js` — collapses whitespace and
  title-cases scraped job title/company/location before they're saved,
  instead of persisting the raw scraped strings.
- `icon-close` symbol to the shared icon sprite (`src/shared/icons.svg`),
  used by the new detail panel's close button.
- On-device LLM field extraction (`src/shared/llmEngine.js`, using
  [WebLLM](https://github.com/mlc-ai/web-llm) vendored as
  `vendor/web-llm.js`, model `Qwen2.5-0.5B-Instruct-q4f16_1-MLC`) replacing
  the synonym/attribute-based matcher previously in `content.js` — runs
  entirely in the background service worker, with no network call per
  extraction after the one-time model download. Started on the 3B variant
  of the same model (~2.5GB vs. 0.5B's ~945MB); switched down after manual
  testing surfaced how rough the first-install download is on a slow
  connection — see `docs/roadmap.md`'s "Model size vs. accuracy" for the
  size/accuracy tradeoff and the fuller comparison against WebLLM's other
  prebuilt models.
- Model-load status tracking (`src/shared/llmStatus.js`), shown as a status
  line on the onboarding confirmation screen and a status chip on both
  dashboard pages, both updating live via `browser.storage.onChanged`.
- A one-time "Liber's on-device AI is ready" notification
  (`background.js`'s `warmupAndNotify`, persisted via `storage.js`'s
  `hasNotifiedLlmReady`/`markLlmReadyNotified`) the first time the model
  finishes loading — added alongside the smaller model above, so a slow
  first-install download doesn't require watching the status chip to know
  when it's done.
- A "Liber can't scrape this application yet" notification, shown in place
  of the usual save prompt when the on-device model isn't ready yet
  (unsupported browser, still downloading, or failed to load) — there is no
  fallback to the old matcher.
- Explicit `content_security_policy.extension_pages` in `manifest.json`
  (`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`) — needed for
  WebLLM's WebAssembly (tokenizer/runtime) to instantiate in the background
  service worker.

### Added
- JSON-LD `JobPosting` structured-data extraction (`src/shared/jobPostingLd.js`,
  duplicated inline in `content.js` and `background.js`'s injected
  cross-tab scanner) — a free, deterministic alternative to the on-device
  LLM, tried first on every step; when complete, the LLM is skipped
  entirely for that step.
- `src/shared/partialJsonSnapshot.js` — scans a streamed LLM response for
  the moment all three fields have closed, so `extractJobFields` can call
  `engine.interruptGenerate()` before the model finishes generating its
  closing `}`/end-of-generation token.
- A small unobtrusive on-page progress badge (`content.js`), shown only
  when a flow actually needs the model and it isn't ready yet, driven by
  `llmStatus.js`'s status now being pushed to every open tab (not just
  readable from storage, which content scripts can't do reliably).
- `alarms` permission (`manifest.json`) and a recurring idle-unload check
  — the LLM engine is now explicitly unloaded (`llmEngine.unloadEngine()`)
  once a flow's fields are all known, on flow abandonment, and after 5
  minutes of no extraction activity.
- A dedicated post-signup setup screen (`onboarding.html`/`onboarding.js`)
  replacing the old plain confirmation message — a progress bar while the
  model loads, then a ready state (with an OK button that closes the
  tab), a friendly error state with a Retry button, or a friendly
  "can't finish on this device" state, all worded with no "AI"/"model"/
  "WebGPU" mentions. Skips straight to the ready state if already cached.
  `onboarding.js` now also triggers the load unconditionally as soon as
  its page loads (not gated on submit), giving it a head start.
- A best-effort WebGPU software-adapter heuristic
  (`llmEngine.js`'s `isSoftwareAdapter`) — checks `GPUAdapterInfo` for
  known software-renderer names (SwiftShader, llvmpipe) and treats a
  match as `"unsupported"`, so a Chromebook-style software-emulated GPU
  gets the clean "can't finish setting up" message instead of a painfully
  slow working load. Not a guarantee — no standardized WebGPU flag exists
  for this, so an unrecognized software renderer wouldn't be caught.
- A "Scrape Activity Log" popover (`dashboard-core.js`'s
  `openLogsPopover`) on the full view, opened via a new header button,
  dismissible via a close button, Escape, or an outside click — same
  anchored-popover pattern as the existing notes/profile popovers.

### Changed
- **Model loading is now lazy, not eager.** `warmup()` used to be
  triggered on every install, browser startup, onboarding submit, and
  dashboard open, specifically to have the model ready before the first
  apply click. It's now triggered only once `content.js`'s listing check
  confirms an actual single-job apply flow is starting — trading some
  first-use-per-session latency (mitigated by the new progress badge
  above) for not holding a loaded model's RAM/GPU footprint for installs
  that never apply to anything in a session. See `docs/roadmap.md`'s
  "Minimizing on-device LLM usage" for the full reasoning.
- `extractJobFields` (`llmEngine.js`) now streams its response instead of
  waiting for one blocking completion, and `background.js`'s
  `handleFlowStep` skips calling it at all once a flow's three fields are
  already known, and otherwise reuses a per-URL cache
  (`urlExtractionCache`) instead of re-running it on a page already
  extracted.
- `content.js`'s `collectPageText` (and `background.js`'s
  `liberScanInjectedPage`) now strip `nav`/`header`/`footer` and their
  ARIA-landmark equivalents (temporarily hiding, reading, restoring, since
  `.innerText` needs live layout) before reading page text, instead of
  including whatever site chrome happened to be inside the resolved
  scope.
- `countVisibleJobTitles` (`content.js`) now breaks its scan as soon as a
  second distinct job title is found, instead of always walking every
  matching element on the page.
- `background.js`'s `LIBER_LLM_WARMUP` handler now calls `warmup()`
  directly (no longer wrapped in a "ready" OS notification — see Removed)
  and also sets `lastLlmActivityAt`, so a signup-preloaded-but-never-used
  engine is now eligible for the idle-unload alarm too, not just one
  that's actually run an extraction.
- The "Liber can't scrape this application yet" notification's wording
  (`showNotReadyPrompt`) no longer mentions "AI"/"model"/"WebGPU".
- Dashboard greeting now shows the user's profession with their initial in
  an avatar badge, instead of their full name in the text.
- Dashboard delete action is now an icon button instead of a text link.
- Reworked spacing scale (`--space-1`…`--space-12`) and refreshed light/dark
  color palette, including softer, pill-style job status colors.
- Replaced the text "L" logo mark with `src/assets/logo.png` across the
  popup, full view, and onboarding pages; regenerated extension icons and
  favicons.
- Notes and profile popovers now share a common `.dashboard__popover` base
  style with a close animation.
- Removed the full view's unwired sidebar "Settings" placeholder link — the
  profile popover is the only profile-related entry point for now.
- Regenerated `icon48.png`/`icon128.png` — the previous regeneration had
  actually produced JPEGs saved with a `.png` extension, at the wrong pixel
  dimensions (34×31 and 80×71 instead of 48×48 and 128×128), which made
  Chrome fall back to its default extension icon. Both are now proper PNGs
  at their declared sizes, generated from `src/assets/logo.png`.
- Full-view table rows and popup cards are now clickable (open the detail
  panel / navigate to the full view), in addition to their existing inline
  controls — those controls now stop click propagation so they don't also
  trigger the row/card click.
- Delete button's hover background changed from a near-invisible
  transparent red to the same solid pastel red as the "Rejected" status
  pill, and its corner radius now matches the rest of the UI instead of a
  full circle.
- Profile popover (opened from the collapsed sidebar's avatar) now anchors
  to the sidebar panel's own right edge with a gap, instead of the shrunk,
  centered avatar button — it no longer opens partially overlapping the
  sidebar.
- Onboarding confirmation screen simplified — dropped the circular
  checkmark icon and widened/relaxed the confirmation copy.
- Popup "View all applications" button's tooltip now matches its visible
  label.
- `content.js` no longer resolves `jobTitle`/`company`/`location` itself —
  it ships bounded, raw scope text to `background.js` (`scopeText` replaces
  `snapshot` in the `LIBER_FLOW_STEP` message), which resolves it into
  fields via the on-device LLM. Click-trigger detection and
  `countVisibleJobTitles` are unchanged; scope resolution itself
  (`findCardScope`/`findActiveCardScope`/`findLocalScope` at the time) was
  further simplified shortly after — see below.
- Apply-capture flow simplified from click-time card/landmark scoping to a
  defer-and-watch model: a trigger click no longer blocks navigation or
  resolves any DOM scope synchronously (`findCardScope`/
  `findActiveCardScope`/`findLocalScope`/`resumeDefaultAction` removed) —
  it just fires an "arming" message and lets the native action proceed,
  then scans once a modal actually appears (`findVisibleDialog`, watched
  via `MutationObserver`) or, failing that, once the page settles
  (`watchForStepChange`'s `SETTLE_WINDOW_MS` fallback, for non-modal
  in-place step changes). The "Save this job application?" prompt now
  waits for `jobTitle`, `company`, and `location` to all be known before
  showing, instead of on the first field found — with a tab-close fallback
  (`tabs.onRemoved`) that prompts with whatever partial data exists if a
  flow never completes. Apply flows now also follow a same-tab page
  navigation or a brand-new tab (e.g. an ATS redirect to a separate
  domain) — `background.js`'s new `tabs.onUpdated` listener recognizes a
  recently-armed flow and scans the destination automatically via
  `scripting.executeScript`, inheriting the flow across tabs via
  `flowStorage.js`'s new `copyFlow`. See `docs/architecture.md`'s
  "Defer-and-watch scanning" and `docs/roadmap.md`'s "Capture flow
  rewrite: defer-and-watch" for the full design and its tradeoffs.
- Scraping now requires Chrome/Chromium (WebGPU) — there's no fallback path
  on Firefox, despite `manifest.json` still shipping
  `browser_specific_settings.gecko`. See `docs/roadmap.md`.
- Opening either dashboard page now also sends `LIBER_LLM_WARMUP`, not just
  onboarding's post-submit send — resumes a model load that stalled (e.g.
  the service worker was suspended mid-download) without needing an apply
  click or a trip back to onboarding.
- Onboarding's status line and the dashboard status chip's tooltip now
  explicitly frame the model download as one-time and non-blocking ("you
  can start using Liber in the meantime"), instead of just a bare percentage.

### Fixed
- `manifest.json`'s `background` block declared both `service_worker` (MV3)
  and `scripts` (MV2-only) — invalid under `manifest_version: 3`, and on a
  strict-enough Chrome build it silently prevented the service worker from
  registering at all (no console output, `chrome://extensions` showed it
  permanently inactive). Pre-existing, unrelated to the LLM work above;
  surfaced during manual testing of it. `scripts` removed — Chrome needs
  only `service_worker`. Firefox's background currently relies on
  `scripts` instead (its own MV3 implementation doesn't reliably support
  `service_worker` the same way), so this also means `background.js`
  doesn't run on Firefox at all right now — a bigger version of the
  already-accepted Chrome-only tradeoff above, not a new one.
- `llmEngine.js`'s "not ready" status could occasionally read as stale —
  `extractJobFields` used to kick off `warmup()` and then separately
  re-read `getLlmStatus()` straight after, which could land on either side
  of that same `warmup()` call's own status write (e.g. reporting "still
  loading" for a click that was actually about to resolve as
  "unsupported"). Fixed by having the status written and the error thrown
  happen atomically in one place (`failWith`), so a caller's rejection
  always carries the exact status that produced it. Also made the
  `unsupported` outcome sticky (no longer retried/reset on every call) —
  it's a stable fact about the browser/device, so retrying only reopened
  the same race for no chance of a different answer.

### Removed
- Platform column from the dashboard and `platform` field from stored job
  records — the scraper still uses per-platform selectors to detect and
  scrape jobs, it just isn't persisted or displayed anymore.
- Excel-style click-to-expand behavior on truncated table cells — they now
  just truncate with an ellipsis and a `title` tooltip on hover.
- Popup "Recent applications" section label.
- The synonym/attribute-based field matcher (`findBySynonyms`,
  `firstMatchText`, `MICRODATA_ITEMPROP`, and the `company`/`location`
  bands of `FIELD_SYNONYMS`) from `content.js`, replaced by the on-device
  LLM above. The bare-word `jobTitle` hints that fed
  `countVisibleJobTitles`' multi-listing detection survive, renamed to
  `JOB_TITLE_HINTS` — that's a deterministic heuristic unrelated to field
  extraction accuracy.
- The dashboard's `liber_llm_status`-driven status pill (`#llm-status-chip`,
  `renderLlmStatusChip`) on both the toolbar popup and full view — the new
  post-signup setup page now covers that, and the pill mentioned "AI".
- The one-time "Liber's on-device AI is ready" OS notification
  (`background.js`'s `warmupAndNotify`/`notifyWhenReady`) and its
  supporting persistent flag (`storage.js`'s `hasNotifiedLlmReady`/
  `markLlmReadyNotified`) — same reasoning as the pill above.
- The full view's inline "Scrape Activity Log" section — moved into a
  popover, see Added.

### Fixed
- The on-device model never loaded at all after the offscreen split above —
  `offscreen.js`'s status writes (`setLlmStatus`/`getLlmStatus`) threw
  immediately, since Offscreen Documents only expose `chrome.runtime`
  messaging, not `chrome.storage` (confirmed directly: `typeof
  chrome.storage` is `"undefined"` there). `liber_llm_status` silently
  never left `{}`, with no visible error (the service worker goes dormant
  between messages, taking its console with it). Fixed by having
  `offscreen.js` keep status locally and relay it to `background.js` via a
  new `LIBER_OFFSCREEN_STATUS` message — `background.js` is the only
  context that persists it now. See `docs/roadmap.md`'s "Bug found after
  shipping the offscreen split" for the full writeup, including two
  smaller bugs that made this manifest as "no errors anywhere."
