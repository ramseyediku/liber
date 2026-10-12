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

### Removed
- Platform column from the dashboard and `platform` field from stored job
  records — the scraper still uses per-platform selectors to detect and
  scrape jobs, it just isn't persisted or displayed anymore.
- Excel-style click-to-expand behavior on truncated table cells — they now
  just truncate with an ellipsis and a `title` tooltip on hover.
- Popup "Recent applications" section label.
