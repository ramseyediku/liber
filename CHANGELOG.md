# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.0] - Unreleased

### Added
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

### Changed
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
