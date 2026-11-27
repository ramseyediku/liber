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

> **Reading guide.** The sections from "Components" down to "Design notes: dedup
> key" were written before the TypeScript migration and the local-first/sync
> work: they still say `.js`, describe a notification-based confirm step and a
> server-first storage layer, and are partly out of date. The sections from
> "Capture: JSON-LD → stored site structure → Claude" onward are current, and
> are where decisions made since then are recorded (with who decided what).

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

## Capture: JSON-LD → stored site structure → Claude

On "yes" to the save prompt, `background.ts` resolves the job's fields from the
cheapest source that works, in order:

1. **The page's own JSON-LD** (free, no network).
2. **A stored site structure.** `site_structures` (shared across users, one
   `is_active` row per hostname) holds CSS selectors for jobTitle / company /
   location. `content.ts` runs them against the *captured* HTML (not the live
   page, which may have changed since the click). Title and company are
   required; location is optional.
3. **Claude** (`extract-job-fields`), given the cleaned HTML of the job
   (header/footer/nav, scripts, media, hidden and empty nodes stripped, attributes
   cut to id/class/data-*/itemprop/role/aria-label; capped at 24k chars). It
   returns the fields and a selector per field.

**Learning.** Claude's proposed selectors are run against the same captured
HTML; only if they reproduce Claude's own answer (`selectorsReproduce`) does
the `site-structure` function store them (new version, made active, previous
active version switched off). **Scoring.** Each use of an active structure is
reported back (`report`); 3+ failures exceeding its successes switches it off so
the site falls back to Claude and re-learns.

Why selectors-on-captured-HTML: the service worker has no DOM, and learning and
applying then see exactly the same input. Why only selectors are stored: no page
content, URLs or user data ever go into the shared table. **Known risk:** the
table is shared and the extension asks the function to write it, so a hostile
client could submit bad selectors for a site. Writes are limited to validated
plain-CSS selectors and a bad one is switched off by failure reports, but
promotion could be tightened (e.g. require agreement from two users).

### Choosing the right job on a multi-job page

**The bug.** Stored selectors are generic (`.job-title`, `.company`). On a page
that shows several jobs (a card list, or a list beside a detail pane) a
selector matches *all* of them, and `querySelector` returns the first. So the
first visit to a site was right (Claude read the page) and the second visit
saved the first job in the list rather than the one applied to.

**The decision (the user's).** When a stored structure is used, do not search or
reason about which text is right. Of all the elements matching a selector, take
the one **closest to the Apply button actually clicked**. It is deterministic
and costs no Claude call — the whole point of storing a structure is to stop
paying for Claude to reason about the page, and having it reason about *which*
job would bring that cost back. Claude is only involved the first time.

**Mechanics (`content.ts`).**
- The clicked element is tagged `data-liber-clicked="1"` on the live DOM just
  long enough for `collectScopeHtml` to copy it, then untagged (the page is left
  as it was). The tag survives cleaning even though a `<button>` or an empty
  element would normally be stripped — it is the anchor everything is measured
  from.
- `nearestMatch` takes `querySelectorAll(selector)` and scores each match by the
  number of DOM steps between it and the button (up to the shared ancestor and
  down), doubled, plus 1 if the match comes *after* the button — a card's title
  precedes its Apply button, so on a tie the earlier node wins. Lowest score wins.
- One match, or no tag (an older capture), falls back to the first match.
- Claude's proposed selectors are checked through this same function before
  being stored, so a structure is validated under exactly the rule that will
  apply it. Claude is also told about the tag in its prompt, so the first read
  extracts the clicked job, not just the first one on the page.

**Known limits.** If the Apply button sits inside a container that cleaning
strips (`header`, `nav`) the tag is lost and the first match is used. A site
whose cards are not structurally near their own buttons could still pick the
wrong one. Verified under jsdom on a three-job listing (clicks on #1, #2, #3) and
a list + detail-pane layout; not yet on live sites.

### When the page is messy (Claude can't make out the structure)

Reported by the user: on messy pages Claude sometimes could not find the fields.
What it was being given, and the specific weaknesses that follow from that:
- **Only HTML.** The visible text was sent only when the HTML was empty, so on
  div-soup pages Claude lost the reading-order text, which is usually clearer.
- **No page-level signals.** `<meta>` and the header are stripped, so the
  document title, `og:title`, site name and `<h1>` — often "Job title – Company"
  even on a messy page — never reached Claude.
- **Cut from the top.** The 24k cap kept the *start* of the scope, so on a wide
  scope (a long listing page) the clicked job could fall past the cut.
- **One shot, smallest model.** No retry when title or company came back empty.

What changed: `content.ts` sends **page hints** (title, og:title, og:site_name,
description, up to three `<h1>`s); `extract-job-fields` gives Claude hints + HTML +
the visible text together and a prompt that says the HTML may be messy and to lean
on text and hints then; HTML over the cap is **windowed around the clicked
button** instead of cut from the top; and if the first (Haiku) answer lacks a title
or a company, **Sonnet is asked once** with the same input. The retry is not a
second quota unit, so it costs the user nothing; it costs us only on the pages
that failed. The capture log shows the model used and whether it escalated. Verified
under jsdom (hints collected; clicked job kept when the page is far over the cap);
not yet measured on real messy sites — the next step is to collect failing pages
from the capture log and see which signal was missing.

Still open for messy pages: a scope that resolves to the wrong container, and
plain text that is itself capped at 4k from the start of the scope.

### Why a structure is keyed by hostname, and also records the URL

The user asked for the structure to be saved with its associated URL so the next
visit reuses it instead of calling Claude. The table key stays the **hostname**
(`site_structures` is unique on `(hostname, version)`, one active row per
hostname): a job URL is different for every posting, so keying on it would send
every new posting back to Claude. The page it was learned from is stored in the
`structure` JSON as `learnedFrom` — origin + path only, query string and fragment
dropped, because those can carry session or tracking data — and the capture log
shows it when that structure is used.

### The capture log says which method answered

Every capture writes a `method:` step and a summary whose first line is the
method: the page's own structured data (JSON-LD); a stored site structure vN
for the host (no Claude call); Claude (first read of this page); or Claude's
cached answer for the same page this session (no new call). The summary also
states whether Claude was called, what happened to the site structure (used /
learned and stored / proposed selectors did not reproduce the page / none), and
the save outcome.

### The snapshot at the moment of applying

The user's rule: the page is captured at the instant Apply is clicked (scope
HTML, visible text, page hints, JSON-LD — synchronously, before the click's own
navigation runs), and that snapshot is what gets read, even if the page reloads,
redirects, or opens the application in a new tab before the user answers. They
accepted it being less efficient to be sure the capture is never lost. "No"
deletes the snapshot; "Yes" sends it with the save; closing the tab deletes it;
it is not offered after 10 minutes.

It is kept in `storage.session`, keyed by tab, not in the background worker's
memory: MV3 stops an idle worker after about 30 seconds, which silently lost
the snapshot before. `storage.session` survives that, stays in memory and is
cleared when the browser closes, so page content is never written to disk. The
capture log records when a snapshot is kept, restored after a page change, or
deleted on "No".

### Popups, dialogs and modals

Asked for by the user: snapshot popups too. Three gaps were found and two fixed:
1. **The popup is the application form; the job is behind it.** When Apply/Submit
   is clicked inside a popup (a dialog by its semantics, or a large fixed overlay
   without them), the capture now holds two parts: `data-liber-part="popup"` (with
   the clicked button) and `data-liber-part="page-behind"` (the first `main` /
   `article` outside the popup, else the body with the popup cut out). Each part is
   cleaned on its own budget (13.5k + 10k characters of HTML, 2.4k + 1.6k of text)
   so neither crowds the other out. Claude is told what the parts mean, and stored
   selectors run against the same combined capture.
2. **Popups built as web components (shadow DOM).** At document level a click
   inside a shadow root is retargeted to the host, so it was not recognised as an
   Apply click at all, and `cloneNode` skips shadow content. The click handler now
   uses `event.composedPath()` to find the real control, scope lookups walk up
   through shadow hosts, and the capture inlines open shadow roots
   (`<div data-liber-shadow>`). Closed shadow roots stay unreachable to any
   extension.
3. **Popups inside iframes (embedded application forms) — not done.** The content
   script runs only in the top frame. Running it in every frame (`all_frames`)
   would catch them, but the prompt would then appear inside the iframe, and a
   cross-origin frame cannot see the job details on the page around it. A decision
   for later.

Also: `div`s with `role="button"` (common in popups) now count as clickable.
Verified under jsdom (modal form + job behind it, a shadow-DOM popup, a
`role="button"` submit); the overlay-without-semantics path needs layout and was
not testable there.

### When there is no job to read

Some pages have no structure to learn from (a newsletter "Submit", an empty modal,
a site with no usable markup). Two places catch that, both without saving an
"Unknown title / Unknown company" row:
- **Before asking** (client only, nothing sent): no JSON-LD and under 60
  characters of text around the click → the prompt is replaced by "No job found
  here — try applying from the job's own page."
- **After extraction**: if none of JSON-LD, a stored structure or Claude produced a
  job title or a company (including Claude's free limit being used up), nothing is
  saved and the result is the new `nothing-found` outcome with the same message.
  The capture log records why (Claude's state and the structure's).

### The save prompt

A card (440px wide) at the top centre of the page, built inside a shadow root
with `!important` host styles so the site's own CSS can't move or hide it. Every
Apply click makes a **new** prompt: any popup already showing (whatever phase)
fades out while the new one fades in. A save that finishes while a newer prompt
is open does not replace it. Note for testing: a content script already running
in an open tab keeps the old code after the extension is reloaded — refresh the
page, or the old popup (it was once bottom-right) is what you will see.

The floating capture-log button (`src/dashboard/captureLog.ts`, bottom-right of the
full dashboard) shows the rolling log in `storage.session`: what was captured,
which source answered, whether Claude was called, and the save outcome. It is on
by default for unpacked installs; Settings → Developer toggles it. (An earlier
version injected it into every web page; it moved to the dashboard so nothing
is added to pages the user visits.)

## Where job data lives: local-first, Supabase only with Cloud Sync

With Cloud Sync **off** nothing about a job or a job profile is sent to
Supabase. `storage.ts` applies saves, edits, deletes and new profiles to
`browser.storage.local` and queues them (`liber_pending_creates`,
`liber_pending_updates`, `liber_pending_deletes`, `liber_local_profiles`). With
sync **on**, saves go straight to `record-save` (which enforces the free limit
and dedups), and `flushPendingUpdates()` pushes the rest in batches: on
dashboard load, every minute, and when the page is hidden. Order: profiles →
new jobs (with their original date) → deletes → edits.

Because nothing reaches the server to enforce them while sync is off, the free
limits are applied locally too: 10 saves ever (`FREE_JOB_LIMIT`, the same
lifetime count as the server's `usage.saves_used`, so deleting never frees a
slot) and no extra profiles (`FREE_EXTRA_JOB_PROFILES = 0`). `isPaid()` caches its
last answer so a paid user offline isn't treated as free.

**Delete is a real delete.** The bin hides the job and starts a 10s undo window
(the toast shows 6s). After that the next flush removes it from the device and,
if it exists in Supabase, runs `DELETE FROM jobs WHERE id = …` from the client.
No Edge Function is needed: `jobs_delete_own` (RLS) lets an authenticated user
delete their own rows, guests included. A job that was never uploaded just
disappears locally. If sync is off, a delete of a job that *is* in Supabase waits
in the queue and is applied the next time sync is on.

**Turning sync on** uploads the queued profiles and jobs, then adopts the
account's own profile if this device's isn't among them
(`adoptAccountJobProfile`). Jobs the free cap refuses stay on the device only:
their ids go in `liber_local_only`, which keeps them in the list when sync is
on (before this, the next refresh rebuilt the cache from the server and they
silently vanished), keeps their edits queued rather than sent to `update-job`
for a row that doesn't exist, and makes their delete local-only. Once the
account is paid, the next flush puts them back in the upload queue.

**Adding a job by hand** (the dashboard's Add button) goes through `addJob`
like a capture, so dedup and the free limit apply the same way. It can also set
status, date and notes: the date goes to `record-save` as `dateApplied`, and
status/notes follow as an ordinary edit because `record-save` only takes the
captured fields.

**Importing a CSV** (Settings → Account & Data; parser in
`src/shared/csvImport.ts`) reads Liber's own export and the usual spreadsheet
headings, into a chosen profile. The user's rule: the free limit never refuses
an import, but every imported job counts towards the 10 free saves, so the next
save or add after an import that went over is the one that's stopped. Imported
jobs are always written locally and queued (`importJobs`), whatever the sync
setting, and go up with the next flush — so with sync on, the server's own
limit still decides what reaches Supabase, and anything over it stays on the
device (above). Letting imports past the server's limit too would need a
database change (see the roadmap). Rows that duplicate a job already saved, or
another row in the file, are skipped; a/b/yyyy dates are read day-first unless
only month-first makes sense.

**Local data is per account** (`src/shared/accountStore.ts`). Every per-account
key (jobs, job profiles, queued uploads, sync setting, paid cache) is stored as
`<key>:<user id>`. Logging out sends the user to the welcome page as a new guest —
a new user id — so the previous account's data is hidden, not deleted, and returns
if that account logs in on this device again. This was the user's call over
clearing data on logout: guests can't sync and only real accounts can log in, so
hiding is enough, and nothing saved only on this device is lost. It also keeps one
account's queued uploads from being sent under another. A guest who signs up keeps
the same id (in-place upgrade), so their data carries over. The user id is read
from the stored session on every access, not cached, so the background worker
never keeps writing under an account a page has logged out of. Data written
before this change is moved under whoever is signed in, once. Delete account
removes only that account's keys. App pages require a display name (read from
the local session); without one — a fresh guest, or right after logout — they send
the user to the welcome page.

**Sync conflicts (the user's decision).** Every time Cloud Sync is turned on,
this device is compared with the cloud. Jobs that exist on only one side are
simply merged. The same job (same id) with different content on each side
(status, notes, title, company, location, URL) is a conflict, and the user is
asked which version wins: *Keep this device's version* (queued as patches and
pushed up), *Keep the cloud version* (replaces the local copies), or Cancel
(sync stays off). There is no base version, so we cannot tell which side
changed — any difference is treated as a conflict, and the granularity is the
whole job, not per field. While sync is off, duplicate detection reads only the
local data (the user's call); the server's own duplicate check applies only to
the sync-on save path and to the upload after sync is turned on.

**A real delete.** The bin used to set `deleted = true`. It now removes the row:
the job is hidden at once with a 10s undo window (the toast shows 6s), then the
next flush deletes it from the device and, if it exists remotely, runs
`DELETE FROM jobs WHERE id = …` from the client. There is no delete Edge
Function because none is needed: `jobs_delete_own` (RLS) lets any authenticated
user, guests included, delete their own rows — confirmed against the live
project with a throwaway user. Free-plan saves are a *lifetime* count on the
server (`usage.saves_used`), so deleting never frees a slot.

## Accounts: a guest is upgraded in place

Everyone starts as an anonymous (guest) Supabase user. When they sign up on the
same device, the guest is **upgraded in place** with `auth.updateUser({ email,
password })` — same user id, so their jobs and profiles carry over and no
orphaned guest account is left behind.

The user's first proposal was to *delete* the guest after sign-up, matching it by
IP address and display name. The recommendation was the in-place upgrade instead
and the user chose it: an IP + name match can hit someone else's guest (shared
networks, common names) and the deletion cannot be undone, whereas the upgrade
needs no matching at all. `signUp()` (a brand-new user) remains only as the
fallback when there is no guest session. Guests orphaned by sign-ups made before
this change are not cleaned up.

**Email confirmation is switched off** in the Supabase project (the user's
call, "to remove extra friction"), so the upgrade completes immediately. If it is
turned back on, `is_anonymous` stays true until the emailed link is opened and the
sign-up page says so instead of redirecting. Cost of turning it off: an email
typo makes an account nobody can recover by password reset (a "confirm email"
field would cover that), and anyone can register any address.

**First run.** The welcome page asks for a name and an optional role. The name is
the display name (editable later in Settings); the role renames the local default
job profile (same id), so it *is* the user's first job profile; the sign-up page
asks for a display name and prefills it. "Onboarded" is a stored flag
(`liber_onboarded`) rather than "name and role both filled in", because the role
is optional. **Delete account** (`delete-account`) shows a generic "Something went
wrong. Please try again." on any failure, by request; the cleanup after a
successful delete tolerates a failing sign-out.

## Plans and limits

Free: 10 saves ever, one job profile (the default one every account starts with,
so `FREE_EXTRA_JOB_PROFILES = 0` extra), 10 automatic captures. Premium, £3.99
one-time (the price is configured in Stripe, `STRIPE_PRICE_ID`; the Plan tab only
displays it): no limits. The limits are enforced by DB triggers
(`enforce_job_limit` via `consume_quota`, `enforce_profile_limit`) and
`extract-job-fields` (`consume_quota('ai', 10)`), and mirrored in the client
(`FREE_JOB_LIMIT`, `FREE_EXTRA_JOB_PROFILES`) because with sync off nothing
reaches the server to enforce them. `isPaid()` caches its last answer so a paid
user offline is not treated as free.

**Guests can pay; the restore code is how they keep it** (the user's call, over
requiring an account first). Premium is tied to the auth user id, and a guest who
logs out or clears browser data gets a new id, so the restore code is the only way
back. `create-checkout-session` makes the code before payment and puts its hash in
the session metadata; the webhook records it with the purchase. Settings → Plan
shows the code (with Copy) once paid, and a "restore code" form while free. A
checkout that was opened but never finished sends its code back on the next one,
so every checkout tab carries the same code and paying in an older tab can't
leave this device holding the wrong one. A successful restore stores the code too.
After checkout Stripe returns to static pages in `site/`, published to GitHub
Pages by `.github/workflows/pages.yml` (`thanks.html`, `cancelled.html`), since
Stripe needs https URLs and an extension page can't be one.

## Backend: functions, database facts, and how it is operated

| Function | Purpose |
|---|---|
| `record-save` | Saves a job (+ its profile) with dedup and the free limit; takes an optional original `dateApplied` |
| `update-job` | Edits a job (batched from the client) |
| `create-job-profile` | Creates/renames a profile (upsert on id) |
| `delete-account` | Deletes jobs, profiles and the auth user |
| `extract-job-fields` | Claude reads the cleaned HTML → fields + proposed selectors |
| `site-structure` | `learn` / `report` on the shared `site_structures` table |
| `create-checkout-session`, `stripe-webhook`, `redeem-restore-code` | Premium purchase and recovery |

Database facts (read from the live project): jobs/job_profiles have RLS for
select/delete own rows; insert/update additionally need `is_permanent_user()`,
which is why guests write through service-role functions. `site_structures` is
readable by any authenticated user and writable only by service-role.

**Operating it.** Until 11 Nov 2026 none of these functions were deployed to the
project — every call returned 404 `NOT_FOUND`, found by probing each function
with the anon key (a made-up function name returns the identical response).
Deploy with `npx supabase functions deploy <names> --remote=<ref> --yes` (the CLI
refuses hosted mutations from an agent run without `--yes`, which should only be
passed after the user has said yes). Inspect the schema read-only with
`npx supabase db query --remote=<ref> --read-only "<sql>"`. To test a function
end to end, sign in a throwaway anonymous user (`POST /auth/v1/signup`), call it,
then call `delete-account` to clean up. Secrets: `LIBER_LLM_API` is set; the
Stripe ones (`STRIPE_API_KEY`, `STRIPE_PRICE_ID`, `STRIPE_SUCCESS_URL`,
`STRIPE_CANCEL_URL`, `STRIPE_WEBHOOK_SIGNING_SECRET`) are not yet, so checkout and
the webhook return 500 until they are. The return URLs are
`https://ramseyediku.github.io/liber/thanks.html` and `…/cancelled.html`.
`stripe-webhook` must be deployed with `--no-verify-jwt` and subscribed to
`checkout.session.completed`, `charge.refunded` and `charge.dispute.created`.
