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
  `liber_jobs`.
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
  the popup's "Full view" button (`browser.tabs.create`). The sidebar also
  has a "Settings" link that isn't wired up yet (see
  [roadmap.md](roadmap.md)).

`dashboard-core.js`'s `initDashboard()` renders the jobs table
(`getAllJobs`) — a status `<select>` colored per status, a notes button that
opens a small popover to edit notes, a delete button, and a greeting built
from the saved profile (with the user's initial shown in an avatar badge) —
and re-renders automatically on `browser.storage.onChanged` so either page
stays in sync if a job is saved elsewhere. `dashboard-shared.css` holds the
table/select/notes-popover styles common to both pages.

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
profession, intended to be saved via `setProfile`.

> **Known gap:** `onboarding.html` references `onboarding.js`, which does not
> exist yet — so the form currently has no submit handler and never actually
> calls `setProfile`. See [roadmap.md](roadmap.md).

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
