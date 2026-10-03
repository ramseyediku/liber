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
- Table cells for company/title/location truncate with an ellipsis and
  expand in place on click, Excel-style, instead of just overflowing.
- Apply-click sound effect (`src/assets/notif.mp3`, exposed via
  `web_accessible_resources`) for instant feedback when a job is detected,
  played from the content script rather than the confirmation notification
  — see `roadmap.md` for why.

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

### Removed
- Platform column from the dashboard and `platform` field from stored job
  records — the scraper still uses per-platform selectors to detect and
  scrape jobs, it just isn't persisted or displayed anymore.
