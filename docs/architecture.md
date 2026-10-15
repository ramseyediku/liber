# Architecture

Liber is a Manifest V3 browser extension with no build step — the manifest
points directly at source files under `src/`, and `vendor/browser-polyfill.js`
provides the cross-browser `browser.*` API (so the same code runs on both
Chrome and Firefox).

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
  on an unrelated page (e.g. a checkout form) matches too — harmless,
  since a flow with nothing extractable near it never shows a prompt (see
  `extractNearAnchor` below), and `background.js`, not this pattern,
  decides whether a match actually starts or refines a tracked flow (see
  below).
  Earlier versions used two separate patterns here — a narrow one that
  could start a flow and a broader one that could only refine — and
  decided start-vs-refine purely from which pattern matched the clicked
  text. That broke as soon as both patterns were allowed to overlap
  (e.g. widening the narrow one to also catch "Next"): a step-two "Next"
  click on an *already-started* application became indistinguishable from
  a brand-new one, so it would reset the tracked flow (losing
  `savedJobId`/`dismissed`) instead of refining it. This tab's actual flow
  state in `background.js` is the only reliable signal for that
  distinction, so the decision moved there entirely — see `LIBER_FLOW_STEP`
  below.

A match always reports the same shape to `background.js` —
`extractNearAnchor(clickedElement)` — never a full-page scan:

- `LIBER_FLOW_STEP` — sent on every matching click, always with a real
  (possibly empty-string) snapshot. `background.js` decides what this
  means based on whether a flow already exists for the tab — see below.

Every step of this process (trigger matched, listing check, scope
resolution, each field's match, the final snapshot) goes through
`logStep(step, detail)`, which both `console.log`s on the page (prefixed
`"Liber: "`) and relays a `LIBER_LOG` message to `background.js` for
`logStorage.js` to persist — see below — so the dashboard's activity log
(`src/dashboard/` section) can show it live, not just whoever happened to
have that page's own devtools open. Every call also merges in two pieces
of per-click closure state — `jobInfoSoFar` (whatever's been extracted so
far; starts `{ jobTitle: "", company: "", location: "" }` and fills in
as each field matches) and `multipleListingsDetected` (see below) — so
every single log entry is self-contained rather than only the steps that
happen to compute those directly.

`countVisibleJobTitles()` counts distinct visible job titles anywhere on
the page via the same synonym matching built for extraction
(`FIELD_SYNONYMS.jobTitle`). "Visible" means `isVisible()`'s
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
for that history and the one known remaining failure mode (a single-job
page with a genuinely visible "Similar jobs" sidebar could still misread
as "multiple jobs visible," since occlusion doesn't help when the sidebar
isn't actually covered by anything).

`extractNearAnchor(anchorEl)` is the closest-proximity extraction: it finds
`company`/`jobTitle`/`location` using only selector/synonym matching
(`findBySynonyms`) scoped to whatever's nearest the clicked element
(`findLocalScope`) — no JSON-LD, no meta tags, no `document.title`
parsing, and deliberately never the whole document, so the exact same
function is safe to call on the very first capture *and* on a messy
later-step page without risking a full-page scan. `findLocalScope` tries,
in order: `findCardScope`/`findActiveCardScope` (the repeated-card/
active-list-item scopes, see below — but *only* when
`multipleListingsDetected` is true, set once per click from
`countVisibleJobTitles() > 1`) → the nearest `form`/`main`/`[role="main"]`/
`article` landmark ancestor → a fixed, small walk up the tree if there's no
landmark either. It never fully falls back to `document`, intentionally —
see `docs/roadmap.md` for why that was a deliberate, discussed tradeoff,
not an oversight.

Gating the card-scope strategies on `multipleListingsDetected` matters
because they're a false-positive risk on an actual single-job page: either
one can walk up into *unrelated* repeated structure near the clicked
anchor (repeated skill-tag badges, share buttons, breadcrumb items...) and
scope to that instead of the real job content. They're only worth the risk
when the page is known to actually have multiple listings to disambiguate
between in the first place.

This also means a click on a page with multiple listings visible no longer
defers capture — it extracts immediately, relying on `findCardScope`/
`findActiveCardScope` to scope correctly to the specific card clicked
(that card's own title/company/location, already rendered, rather than
waiting on a maybe-still-animating "Easy Apply" modal to populate).

`findBySynonyms(field, root)` checks schema.org `itemprop` microdata
first, then matches synonym words against stable attributes
(`data-testid`, `data-test`, `aria-label`) before falling back to bare
`id`/`class` substrings, each candidate capped by a max plausible text
length (`FIELD_MAX_LENGTH`). `FIELD_SYNONYMS` splits each field's words
into `specific` (compound, e.g. `jobTitle`: "job-title"; `company`:
"company-name") tried first, and `broad` (bare root word, e.g.
"position"/"role"; "company"/"employer") tried only once every `specific`
check has failed — a bare word also matches unrelated same-page UI that
happens to mention it generically (LinkedIn's "Company reviews" link
carries the word "company" too, and was winning over the real
`...__company-name` element until this split was added; see
`docs/roadmap.md`). Candidates are matched via `root.querySelectorAll`,
which can include the clicked element itself or a nearby Next/Continue
button, so `firstMatchText` skips any candidate that itself matches
`isTrigger` — otherwise a button labeled
`aria-label="Apply for this position"` (or "Continue to next step") would
satisfy a synonym match on itself.

On a listing page with multiple job cards, lookups are scoped to the
specific card the user clicked rather than the page's first/default match:
`findCardScope` walks up from the clicked element to the nearest ancestor
with repeated siblings — matched via `sameCardShape` (same tag, at least
one shared class) rather than an exact `className` string match, since
frameworks routinely vary a per-item modifier class (zebra striping, a
"saved" badge) that would otherwise make two genuinely repeated cards look
different. `findActiveCardScope` is a fallback for master-detail layouts
(list + single detail pane, common on LinkedIn/Indeed search results),
where it looks for whichever list item is marked active/selected instead;
`isNavigationChrome` excludes matches inside `nav`/`header`/`footer`/
pagination/breadcrumb containers, since those commonly use the same
"active"/`aria-current` markers for something that isn't a job card.

Only `jobTitle`/`company`/`location` are captured. An earlier version also
scraped `jobDescription` and fell back through JSON-LD/meta
tags/`document.title` parsing when nothing was found nearby
(`getJobPostingLd`, `getMetaContent`, `companyFromUrl`, etc.) — all deleted
with this refactor, since those are page-wide strategies incompatible with
"never scan the full page on a later step." See `docs/roadmap.md` for that
tradeoff.

**Limitation: this doesn't work equally well on every site, by design, not
by oversight.** `findBySynonyms` is a heuristic, not a parser — it works
only as well as a given site's markup happens to carry one of the synonym
words in a stable attribute, `id`/`class`, or schema.org microdata near the
clicked anchor. Sites vary a lot in how (or whether) they expose that
semantic structure: some use schema.org `JobPosting` microdata throughout
(the most reliable case), some use `data-testid`/`aria-label` hooks with
recognizable naming, and some render job details as plain styled text with
no semantic markup at all connecting a `<div>` of text to the concept
"company" or "location" — there's nothing for a synonym match to find in
that last case, regardless of how the synonym list is tuned. This is most
acute for anything resembling a free-text job *description* specifically
(long-form content is the least likely field to carry a consistent
semantic hook across sites, which is part of why it isn't scraped at all
right now — see above and `docs/roadmap.md`), but it's a real, if smaller,
risk for `jobTitle`/`company`/`location` too on a sufficiently unusual
site. The site-agnostic approach (one matcher, every site) was chosen over
a per-site selector table specifically to scale without a maintenance
table that grows forever (see `docs/roadmap.md`'s "Brittle per-site
selectors" entry) — the tradeoff is accepting that coverage is
probabilistic, not guaranteed, and some sites simply won't scrape
reliably no matter how the synonym list is tuned.

**Why probabilistic over deterministic, specifically.** The two
deterministic alternatives both defeat the point of the application, not
just the point of this one function. A per-site selector table is
deterministic but only covers sites someone added a table row for —
functionally per-site job tracking, the exact thing a single extension
that works everywhere is supposed to replace. Asking the user to type job
details in by hand is deterministic too, but at that point the extension
has stopped saving any effort — if the user has to do the data entry
anyway, there's no reason to have an extension doing it semi-automatically
alongside them. A probabilistic matcher that's right most of the time, on
most sites, with zero setup and zero manual entry, is the only option of
the three that keeps that core promise — occasional misses are the cost of
keeping it, not a defect to eliminate.

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
  lastUpdatedAt: number,       // used for lazy TTL expiry, see below
}
```

Responsibilities:
- On first install, opens the onboarding page.
- `LIBER_LOG` → persists the entry via `logStorage.js`'s `appendLog`
  (fire-and-forget; a logging call must never block or fail the scrape
  it's reporting on).
- `LIBER_FLOW_STEP` → looks up the tab's flow (`flowStorage.getFlow`) and
  branches on whether one already exists — this is the single place that
  decides "start" vs. "refine", not content.js (see the content.js section
  above for why):
  - **No flow yet (starting one):** stores a flow with `status:
    "captured"` and the given snapshot, then shows the "Save this job
    application?" notification. (A falsy `snapshot` instead stores
    `status: "pending"` with no notification — content.js no longer sends
    one, now that multi-listing clicks extract via card-scope instead of
    deferring, but this branch is kept so a `null`/empty snapshot from
    anywhere never crashes rather than silently assuming it's safe to
    skip.)
  - **A flow already exists (refining one):** a falsy `snapshot` is a
    no-op; a real `snapshot` merges into the stored one via `mergeSnapshot`
    (`src/shared/
    fieldMerge.js`), logging any genuine field conflicts via
    `console.warn`. If the flow was still `"pending"` and this is the
    first refinement to produce real data, promotes it to `"captured"` and
    shows the prompt now (deferred from the original multi-job click).
    Otherwise just updates the stored snapshot — and either updates the
    already-saved row (`updateJob`, if `savedJobId` is set) or refreshes
    the still-open notification's text (`notifications.update`, if not yet
    saved/dismissed).
- On notification button click: "Save to Liber" → `addJob(flow.snapshot)`,
  then keeps the flow record around (doesn't clear it) with `savedJobId`
  set, so a later refine can still update that row instead of re-prompting.
  "Dismiss" → keeps the flow around too, marked `dismissed`, so later
  refinements still update the stored snapshot without showing the prompt
  again.
- `browser.tabs.onRemoved` clears a tab's flow immediately on tab close;
  `flowStorage.getFlow` lazily expires (and deletes) any flow untouched for
  30 minutes, so an abandoned flow doesn't linger forever without needing a
  persistent timer (which wouldn't survive service-worker suspension in
  MV3 anyway).
- Answers `CHECK_ONBOARDED` messages by checking `isOnboarded()`.

### `src/shared/flowStorage.js` — Ephemeral per-tab flow state

Parallels `storage.js`'s wrapping of `storage.local`, but for
`storage.session` — a flow shouldn't survive the browser restarting the
way a saved job should. One storage key per `tabId` (`liber_flow_<tabId>`,
not one shared object all tabs read/write), which is what makes two tabs'
flows structurally unable to race on the same key.

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
trigger click, no flow yet for this tab     trigger click, a flow already exists
     │                                            │
     │  LIBER_FLOW_STEP                           │  LIBER_FLOW_STEP
     ▼                                            ▼
flowStorage: getFlow() → none              flowStorage: getFlow() → existing flow
     │                                            │
     ▼                                            ▼
flowStorage: setFlow() (start)             fieldMerge: mergeSnapshot()
     │                                            │
     ▼                                            ▼
background.js (notifications.create)      flowStorage: setFlow() (merged snapshot)
     │                                            │
     │  user clicks "Save to Liber"        updateJob() if already saved, or
     ▼                                      notifications.update() to refresh the prompt
storage.js: addJob() → browser.storage.local
     │
     ▼
dashboard.js (storage.onChanged listener) → re-render table
```

(A trigger click on a page with more than one job visible still sends a
real snapshot — `findLocalScope` uses `findCardScope`/`findActiveCardScope`
to scope extraction to the specific card clicked, rather than deferring —
see the content.js section above.

Every `logStep` call in `content.js` also sends a `LIBER_LOG` message,
independent of the flow above — `background.js` persists it via
`logStorage.appendLog`, and the dashboard's activity log re-renders via the
same `storage.onChanged` pattern, keyed on `liber_logs` instead of
`liber_jobs`.)

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

- **Normalization.** `jobTitle` is scraped via `extractNearAnchor`, which
  tries several synonym/attribute bands in order (see the `content.js`
  section above), so the exact same job can come back with different
  casing or stray whitespace depending on which band matched. `buildJobKey`
  lowercases, trims, and collapses whitespace on each part before joining
  them, so those formatting differences don't produce a false "new job".
- **Fixing the data, not the key.** `addJob` falls back to
  `"Unknown company"` for a job with no detectable company. Keying on that
  placeholder directly would be wrong — two unrelated jobs with the same
  title and an undetected company would collide and the second would
  silently vanish. Rather than carve out a special case in the key (e.g.
  falling back to URL when company is a placeholder), the key stays simple
  and relies on extraction being thorough enough that `"Unknown company"`
  stays rare. Note this got narrower with the flow refactor above —
  `extractNearAnchor` only looks near the clicked anchor now, dropping the
  page-wide company fallbacks (URL slug, `Organization` JSON-LD,
  `document.title`) an earlier version had — so an undetected company is
  more likely than before on a site with sparse nearby markup.

Cost-wise, `addJob` already calls `getAllJobs()` to get the array it's about
to `unshift` into — so building `new Set(jobs.map(buildJobKey))` from that
same array is the only extra work added. No second storage read, and the
whole dedup check stays O(n) with a plain hash lookup, same complexity class
`addJob` already had.

On a key collision, `addJob` returns `null` instead of inserting. There's
currently no UI feedback for that — see `roadmap.md`.
