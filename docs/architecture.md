# Architecture

Liber is a Manifest V3 browser extension with no build step at runtime — the
manifest points directly at source files under `src/`, and
`vendor/browser-polyfill.js` provides the cross-browser `browser.*` API (so
the same code runs on both Chrome and Firefox). Two things are vendored,
pre-bundled, and committed rather than loaded at runtime, because MV3's CSP
(`script-src 'self'`) forbids loading either from a CDN:
`vendor/browser-polyfill.js` and `vendor/supabase.js` (a bundled
`@supabase/supabase-js`, built once via esbuild — see that file's header).

Job-field extraction now runs server-side: a Supabase Edge Function calls
the Claude API and returns `{jobTitle, company, location}` — see "Field
extraction, off content.js" below. This replaces an on-device WebLLM engine
that lived in this codebase through several rewrites (see
`docs/roadmap.md`'s "Capture flow rewrite" history); that engine's
WebGPU/Chrome-only requirement no longer applies, since nothing left needs
WebGPU. Data (jobs, job profiles, the user's own name/profession) now lives
in a Supabase Postgres project behind Supabase Auth, not only in
`browser.storage.local` — see "Data model" below.

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

Only `jobTitle`/`company`/`location` are captured — the Claude prompt
(the Supabase Edge Function behind `extraction.js`) only asks for these
three fields. See `docs/roadmap.md` for `jobDescription`'s status.

### Field extraction, off content.js

`content.js` never resolves `jobTitle`/`company`/`location` itself — it
just ships plain scope text to `background.js` (via `LIBER_SAVE_REQUESTED`,
only once the user has consented), which turns it into those three fields
via `src/shared/extraction.js`. An LLM reads the same bounded text as a
human would, so it doesn't depend on a site exposing any particular
markup/attribute convention — the tradeoff is "can the model find job
title/company/location in whatever text is actually there?" rather than
"does this site expose the right attribute?".

### `src/shared/extraction.js` — Claude API via a Supabase Edge Function

`extractJobFields(scopeText)` calls `supabase.functions.invoke(...)` on a
Supabase Edge Function, which calls the Claude API server-side and returns
`{jobTitle, company, location}`. This replaces an on-device WebLLM engine
(formerly `src/shared/llmEngine.js` + `src/offscreen/`, hosting the model
in an Offscreen Document's Worker because MV3 service workers can't spawn
a `Worker` directly) that this project went through several rewrites to
build and tune — see `docs/roadmap.md`'s "Migrate to Claude API +
Supabase" for why it was replaced, and the superseded "Capture flow
rewrite" entries above it for that engine's own history.

Routing the call through an Edge Function, rather than calling Anthropic
directly from the extension, is deliberate: `ANTHROPIC_API_KEY` lives only
as a secret on the Supabase project (`supabase secrets set
ANTHROPIC_API_KEY=...`), never inside the extension itself — a key shipped
inside an installed extension's own files would be trivially extractable
by anyone who inspected it. The extension only ever holds the public
Supabase anon key (`src/shared/env.js`, see "Env plumbing" below), which is
safe to ship client-side; Supabase's row-level security, not secrecy of
that key, is what actually protects data.

**Placeholder, pending the real Edge Function**: `EXTRACT_FUNCTION_NAME`
and the request/response shape in `extraction.js` are provisional — update
both to match once the real Edge Function (calling Claude, presumably with
a forced tool-use call for structured `{jobTitle, company, location}`
output) is wired up.

Consequences of moving extraction server-side, compared to the old
on-device engine:

- **No more model-loading lifecycle to manage.** The old engine needed
  `warmup()`/`unloadEngine()`, a `liber_llm_status` record
  (`src/shared/llmStatus.js`, now deleted), an idle-unload `browser.alarms`
  check, and a 4-state onboarding setup screen — all of that existed only
  because a multi-hundred-MB model had to be downloaded and loaded into
  this device's WASM runtime/GPU before it could run. A server-side Claude
  call has none of that: `background.js`'s `handleSaveRequested` now just
  awaits one function call and reports the outcome.
- **No more WebGPU/device-support requirement.** The old engine required
  WebGPU and was Chrome/Chromium-only in practice (see the now-superseded
  "Required LLM, no fallback" history in `docs/roadmap.md`). Nothing left
  in this codebase needs WebGPU — Firefox's own viability now depends only
  on its MV3 `service_worker` support, not on WebGPU maturity.
- **Still structured-data-first.** `collectJobPostingLd()` (content.js)
  still parses any `<script type="application/ld+json">` `JobPosting`
  block into `{jobTitle, company, location}` *before* anything
  Claude-related happens. When it's complete, `handleSaveRequested` uses it
  directly and skips the Edge Function call entirely; a partial read still
  gets merged in for free via `mergeSnapshot` (`src/shared/fieldMerge.js`)
  — deterministic structured data still outranks the model's guess for
  whichever fields it found. The pure parsing logic lives once, canonically,
  in `src/shared/jobPostingLd.js` (unit-tested) — content scripts can't
  `import` modules, so it's duplicated inline in `content.js`'s own
  `collectJobPostingLd`; keep both in sync.
- **Still a URL-keyed extraction cache.** `background.js`'s
  `urlExtractionCache` (a bounded `Map`) still skips re-running extraction
  entirely on a URL it's already resolved — same rationale as before (a
  validation error can send the user back to retry the same URL).
- **No more client-side streaming/early-stop.** The old engine streamed
  tokens and scanned for the moment all three fields had closed
  (`src/shared/partialJsonSnapshot.js`, now deleted) to call
  `interruptGenerate()` as early as possible — that only mattered because
  generation happened on this device. The Edge Function returns one
  complete response; there's nothing to early-stop client-side anymore.

### `src/background/background.js` — Background service worker

No longer tracks any per-tab persisted state at all — there's nothing left
to persist. Each accepted "Save this job to your tracker?" click is one
bounded async chain (`handleSaveRequested`) that runs to completion
independent of tab lifecycle; a mid-request tab close just means its
eventual result-delivery push fails and falls through to a plain OS
notification, with no special cleanup needed.

Responsibilities:
- On first install, opens the onboarding page.
- `LIBER_LOG` → persists the entry via `logStorage.js`'s `appendLog`
  (fire-and-forget; a logging call must never block or fail the scrape
  it's reporting on).
- `LIBER_SAVE_REQUESTED` → `handleSaveRequested(tabId, {url, scopeText,
  structuredSnapshot})`, fire-and-forget (the real result is delivered
  asynchronously via `LIBER_EXTRACTION_STATUS`, not a direct reply): pushes
  an initial `{phase: "working", progress: 0}`, then resolves a snapshot —
  a complete `structuredSnapshot` is used as-is (skipping the Edge Function
  call entirely); otherwise `scopeText` is resolved via the URL-keyed cache
  or `extraction.js`'s `extractJobFields` (merged with any partial
  `structuredSnapshot` via `mergeSnapshot`, since structured data outranks
  the model's guess). The merged snapshot is normalized
  (`normalizeScrapedText()`, uniformly regardless of source) and passed to
  `addJob` — `null` back means a duplicate (see "Design notes: dedup key"
  below), anything else means it saved. Either result, or any thrown
  failure (network error, not signed in, Edge Function error), is logged
  and reported as an `outcome` (`"saved"`/`"duplicate"`/`"failed"`) via
  `LIBER_EXTRACTION_STATUS {phase: "done", outcome}`. If that push fails
  (no content script to deliver to — tab closed, or navigated to a
  restricted page), `showSaveResultNotification` falls back to a plain OS
  notification with the same outcome text, no buttons (consent already
  happened in-page, so there's no decision left for notification buttons to
  make).
- Answers `CHECK_ONBOARDED` messages by checking `isOnboarded()`
  (`storage.js` — now also implies an active Supabase session, not just a
  saved profile).
- Relays an unanswered consent prompt across a redirect/new tab via
  `pendingConsentByTab` (a `Map<tabId, {url, scopeText, structuredSnapshot,
  capturedAt}>`): `LIBER_CONSENT_PENDING` records one the instant
  `content.js` shows it, `LIBER_CONSENT_RESOLVED` clears it the instant the
  user answers, and `LIBER_CHECK_PENDING_CONSENT` — sent by every
  `content.js` instance on load — hands it to whichever page asks first,
  either the same tab (a fresh instance after a same-tab redirect) or a new
  tab opened from it (via `browser.tabs.get(tabId).openerTabId`), bounded by
  `PENDING_CONSENT_TTL_MS` (2 minutes) and deleted on read either way so it's
  only ever resumed once.
- `browser.tabs.onRemoved` clears `pendingConsentByTab` for the closed tab
  — nothing else needs cleanup; `handleSaveRequested`'s promise chain
  doesn't depend on the tab staying open.

**No local fallback.** As with the old on-device engine, there's no path
back to a client-side matcher if the Edge Function call fails — Liber
reports the `"failed"` outcome rather than silently degrading to a worse
extraction method. Unlike the old engine, this failure mode no longer has
anything to do with WebGPU/device capability — it's an ordinary
network/auth/server error, so there's no separate "not ready" status to
track.

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


### `src/shared/storage.js` — Storage layer

The single source of truth for reading/writing extension data — now backed
by Supabase (Postgres + Auth) instead of only `browser.storage.local`.
Every exported function keeps the same name/shape its callers
(`background.js`, `dashboard-core.js`, `onboarding.js`) already expect, so
none of them needed to change beyond the auth-awareness described below.

- `getAllJobs` / `addJob` / `updateJob` / `deleteJob` — job CRUD against the
  `jobs` table (see the real schema the Supabase project was created with —
  not reproduced here since it's maintained there, not in this repo).
  `deleteJob` is a soft delete (`jobs.deleted = true`), not a row delete,
  since the schema's `deleted` flag exists to let a multi-device sync
  propagate removals. `addJob` checks the new job's composite key
  (`jobTitle`+`company`+`location`, same as before) against the user's
  existing jobs before inserting — there's no DB-level uniqueness
  constraint for this in the schema, so this is a client-side pre-check,
  not a guarantee under a true race; see "Design notes: dedup key" below.
  Every job must belong to a `job_profiles` row (the schema's `NOT NULL
  profile_id`) — there's no profile-picker UI yet, so `addJob` auto-creates
  (and reuses) a single `"General"` `job_profiles` row per user the first
  time they save a job, via `getDefaultProfileId`. Revisit once there's
  real multi-profile UI.
- `getProfile` / `setProfile` / `isOnboarded` — the user's own name/
  profession. The schema has no table for this, so it's stored in the
  Supabase Auth user's own `user_metadata` (`supabase.auth.updateUser({data:
  {...}})`) rather than a new table — naturally scoped to the signed-in
  user already, no RLS policy needed. `isOnboarded()` now also implies an
  active Supabase session, not just a saved profile.
- `STATUS` / `STATUS_META` — the status enum, matching the schema's check
  constraint: `applied`, `interviewing`, `offer`, `rejected`, `withdrawn`
  (no more `ghosted` — the schema doesn't have it).

### `src/shared/supabaseClient.js` — Singleton Supabase client

`getSupabaseClient()` — one `createClient(...)` call, memoized, shared by
every extension context (background, dashboard, onboarding). Configured
with a custom `auth.storage` adapter wrapping `browser.storage.local`
(plain async `getItem`/`setItem`/`removeItem`, matching the vendored
client's `SupportedStorage` type exactly) — required because the
background service worker has neither `window` nor `localStorage`, and
every context needs to read the same persisted session regardless. Reads
`SUPABASE_URL`/`SUPABASE_ANON_KEY` from `src/shared/env.js`, generated from
`.env` by `scripts/generate-config.js` (`npm run config`) — see
`.env.example`. Both values are safe to ship client-side (the anon key is
public by design; Supabase's row-level security is what actually protects
data), unlike `ANTHROPIC_API_KEY`, which never reaches the extension at all
(see the `extraction.js` section above).

### Env plumbing

`.env` (gitignored, never committed) holds `SUPABASE_URL`/
`SUPABASE_ANON_KEY`. `scripts/generate-config.js` (`npm run config`) reads
it and writes `src/shared/env.js` (also gitignored) as a plain ES module —
the extension's own code stays build-step-free at runtime (a normal
`import`), with only this one dev-time generation step whenever `.env`
changes. `.env.example` documents both variables and explains why
`ANTHROPIC_API_KEY` is deliberately absent from this file (see
`extraction.js` above).

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

`dashboard-core.js`'s `initDashboard()` first checks for an active Supabase
session (`refreshSignedInState`) — with none, it shows a plain "Sign in to
see your applications" prompt (`#signed-out`, a button opening
`onboarding.html`) instead of the table/cards, since `getAllJobs`/
`getProfile` now require a session. With one, it renders the jobs table
(`getAllJobs`) — a status `<select>` colored per status, a notes button
that opens a small popover to edit notes, truncated company/title/location
cells that expand in place on click, a delete button, and a greeting built
from the saved profile (with the user's initial shown in an avatar badge
that opens a profile popover with a "Sign out" action on click) — and
re-renders automatically on `browser.storage.onChanged` (keyed on
`liber_jobs_version`, a plain change-signal `storage.js` bumps on every
write — see that section above) so either page stays in sync if a job is
saved elsewhere, plus `supabase.auth.onAuthStateChange` so a sign-in/out
elsewhere (e.g. the onboarding tab) is reflected immediately.
`dashboard-shared.css` holds the table/select/popover styles common to
both pages.

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

### `src/shared/theme.js` — Dark/light mode

A plain script (not an ES module) loaded via a blocking `<script src>` in
the `<head>` of all three pages (dashboard popup, full view, onboarding),
so it runs before first paint and seeds the `--theme-icon` custom property
from the saved preference (`liber_theme` in `localStorage`) or the OS
setting before anything renders. `window.LiberTheme.initToggle(button)`
wires a toggle button's click handler and keeps its accessible label in
sync; the actual color and icon swap is pure CSS, driven by `--theme-icon`
via a `@container style(...)` query in `_base.css`.

### `src/onboarding/` — First-run auth + profile

`onboarding.html` is shown once on install (via `background.js`) and is also
registered as the extension's `options_page`. It now doubles as the sign-up
*and* sign-in screen — a single email/password form (`onboarding.js`)
toggled between "Create account" (`supabase.auth.signUp`, then the
name/profession fields, saved via `setProfile`) and "Sign in"
(`supabase.auth.signInWithPassword`, no profile fields) via a plain link
button (`#mode-toggle-btn`). An inline error message (`#auth-error`) shows
Supabase Auth's own error text (wrong password, email already registered,
etc.) without leaving the page. On success, a simplified confirmation state
("You're all set" / "You're signed in", an OK button that `window.close()`s
the tab — this tab was opened via `browser.tabs.create()` by the extension
itself, which is exactly the case that's allowed to self-close). There's no
model-loading setup screen anymore (the old 4-state loading/ready/
unsupported/error panel, tied to the on-device engine's `liber_llm_status`)
— nothing to warm up now that extraction runs server-side.

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
     LIBER_EXTRACTION_STATUS { phase: "working" } → tab
                   │
       structuredSnapshot complete? ──yes──► use it, skip the Edge Function
                    │ no
                    ▼
       urlExtractionCache hit? ──yes──► reuse cached snapshot
                    │ no
                    ▼
       extraction.js: extractJobFields(scopeText)  (→ Supabase Edge Function → Claude API)
                    │ (may throw → outcome "failed")
                    ▼
       mergeSnapshot(structuredSnapshot, llmSnapshot) if structuredSnapshot was partial
                    │
                    ▼
       normalizeScrapedText() on every field, uniformly
                    │
                    ▼
       addJob(merged)  ── null = duplicate, else saved (Supabase insert)
                    │
                    ▼
       LIBER_EXTRACTION_STATUS { phase: "done", outcome } → tab
                    │
            delivered? ──no──► showSaveResultNotification (OS-notification fallback)
```

Every `logStep` call in `content.js` also sends a `LIBER_LOG` message,
independent of the pipeline above — `background.js` persists it via
`logStorage.appendLog`, and the dashboard's activity log re-renders via the
same `storage.onChanged` pattern, keyed on `liber_logs`.

## Data model

Job and profile data now live in Supabase (Postgres + Auth), not
`browser.storage.local` — the real schema is maintained on the Supabase
project itself, not reproduced here. What `storage.js` returns to its
callers (unchanged shape from before this migration, so `dashboard-core.js`
etc. didn't need to change):

```js
// getAllJobs(): Job[] — mapped from the `jobs` table
{
  id: string,            // jobs.id (uuid)
  company: string,       // jobs.company
  jobTitle: string,      // jobs.title
  url: string,           // jobs.url
  dateAdded: string,     // jobs.date_applied (date)
  status: "applied" | "interviewing" | "offer" | "rejected" | "withdrawn",
  location: string,      // jobs.location
  notes: string,         // jobs.notes
}

// getProfile() — stored in the Supabase Auth user's own user_metadata,
// not a table of its own
{
  name: string,
  profession: string,
}

// liber_jobs_version, in browser.storage.local — a plain change-signal
// storage.js bumps on every Supabase write, purely so
// dashboard-core.js's existing browser.storage.onChanged listener still
// fires a re-render now that job data itself doesn't live here

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
previous designs' `liber_candidate_<tabId>`/`liber_attempt_<tabId>`
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
title) collides constantly ("Software Engineer" exists everywhere). The
Supabase schema has no DB-level uniqueness constraint backing this, so
`addJob`'s pre-check is the only thing enforcing it — a true race (two
saves of the same job resolving concurrently) could in theory still insert
twice; not seen as a real problem in practice (the same tradeoff the old
local-only design accepted too), flagged rather than engineered around
with a DB constraint that isn't part of the schema as given.

Two things had to be true for that key to actually work, both addressed
alongside the dedup check itself:

- **Normalization.** `jobTitle` comes back from `extraction.js`'s
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
