# Architecture

Liber is a Manifest V3 browser extension with no build step — the manifest
points directly at source files under `src/`, and `vendor/browser-polyfill.js`
provides the cross-browser `browser.*` API (so the same code runs on both
Chrome and Firefox).

## Components

### `src/content/content.js` — Content script

Injected into every page (`<all_urls>`, `document_idle`). Listens for clicks
in the capture phase, checks if the clicked element's text matches an "apply"
keyword (`APPLY_KEYWORDS`), and if so scrapes job details from the DOM using
`PLATFORM_SELECTORS` — a per-hostname map of CSS selectors (currently
LinkedIn and Indeed, plus a generic `default` fallback). Sends the scraped
payload to the background worker via `browser.runtime.sendMessage` as a
`JOB_APPLY_DETECTED` message.

`company` in particular falls through a long chain of guesses, in order of
trust: platform selector → `JobPosting` JSON-LD `hiringOrganization` →
`og:site_name` meta tag → generic `[class*="company"]` selector → a
known-ATS URL slug (`companyFromUrl` — Lever/Greenhouse/Workday/
SmartRecruiters/Ashby/BambooHR embed the company in their hostname or path)
→ a page-wide `Organization` JSON-LD block (`getOrganizationLd`, broader
than the JobPosting-scoped lookup above) → the non-title segment of
`document.title` (`companyFromDocumentTitle`) → `""`. The extra fallbacks
exist so a seen-but-unlabeled company is still captured — see "Design
notes: dedup key" below for why that matters beyond just a nicer-looking
dashboard.

### `src/background/background.js` — Background service worker

The central coordinator. Responsibilities:
- On first install, opens the onboarding page.
- Receives `JOB_APPLY_DETECTED` messages, stashes the payload per-tab
  (`pendingByTab`), and shows a confirmation via `browser.notifications`.
- On notification button click, saves the job (`addJob`) if the user chose
  "Save to Liber", then clears the pending state.
- Answers `CHECK_ONBOARDED` messages by checking `isOnboarded()`.

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
click on page
     │
     ▼
content.js (detect + scrape)
     │  runtime.sendMessage(JOB_APPLY_DETECTED)
     ▼
background.js (notifications.create)
     │  user clicks "Save to Liber"
     ▼
storage.js: addJob()  →  browser.storage.local
     │
     ▼
dashboard.js (storage.onChanged listener) → re-render table
```

## Data model

```js
// liber_jobs: Job[]
{
  id: string,
  company: string,
  jobTitle: string,
  jobDescription: string,
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

- **Normalization.** `jobTitle` is scraped via several different strategies
  (CSS selector vs. JSON-LD vs. `<title>` fallback) depending on what the
  page offers, so the exact same job can come back with different casing or
  stray whitespace depending on which strategy fired. `buildJobKey`
  lowercases, trims, and collapses whitespace on each part before joining
  them, so those formatting differences don't produce a false "new job".
- **Fixing the data, not the key.** The scraper already had a fallback
  default of `"Unknown company"` for a job with no detectable company. Keying
  on that placeholder directly would be wrong — two unrelated jobs with the
  same title and an undetected company would collide and the second would
  silently vanish. Rather than carve out a special case in the key (e.g.
  falling back to URL when company is a placeholder), the extraction itself
  was made more thorough (see the `content.js` section above) so
  `"Unknown company"` is rare in practice, and the key stays simple.

Cost-wise, `addJob` already calls `getAllJobs()` to get the array it's about
to `unshift` into — so building `new Set(jobs.map(buildJobKey))` from that
same array is the only extra work added. No second storage read, and the
whole dedup check stays O(n) with a plain hash lookup, same complexity class
`addJob` already had.

On a key collision, `addJob` returns `null` instead of inserting. There's
currently no UI feedback for that — see `roadmap.md`.
