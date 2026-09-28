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
- Onboarding page shown on first install, collecting name and profession.
- Shared storage module (`src/shared/storage.js`) wrapping
  `browser.storage.local` for jobs and profile data.
