# Product Spec

## Problem

Job seekers apply across many different sites (LinkedIn, Indeed, company
career pages, ATS platforms like Greenhouse/Lever) and lose track of what
they've applied to, when, and its status — usually falling back to a manual
spreadsheet.

## Solution

A browser extension that notices the moment you apply and asks if you want
to log it, removing the manual data-entry step entirely.

## Target user

Individual job seekers applying to multiple roles across multiple sites over
an active job search.

## Core user flow

1. **First install** — user is taken to the onboarding page, enters their
   name and target profession.
2. **Applying** — user clicks "Apply" (or similar) on any job site. Liber
   detects this and scrapes the visible job details.
3. **Confirm** — a browser notification asks "Save this job application?".
   User clicks "Save to Liber" or "Dismiss".
4. **Track** — saved jobs appear in the dashboard (toolbar popup), where the
   user can update status, add notes, or delete an entry.

## Feature set (current, v0.1)

- Automatic apply-click detection on any site (heuristic keyword matching)
- Site-agnostic scraping via an on-device LLM (WebLLM, running fully
  in-browser — no data leaves the device) — works across sites without a
  per-site selector table, trading some accuracy for coverage. A first
  step toward the trained classifier planned for v2/v3 (see roadmap.md).
  Currently Chrome/Chromium-only (requires WebGPU).
- Save-confirmation via native browser notification
- Dashboard: list, edit status (Applied / Interviewing / Rejected / Ghosted),
  edit notes inline, delete
- Local-only storage, no account or sync

## Design principles

- **No "AI"/"LLM"/"model" language anywhere in user-facing text.** Liber is
  presented to the user only as a job tracker that "sets up" and "scrapes"
  — never as an AI product, regardless of what runs under the hood
  (currently an on-device LLM via WebLLM, see `docs/architecture.md`).
  This was set as an explicit rule for the post-signup setup page (see
  `docs/roadmap.md`'s "Post-signup setup page") and then deliberately
  extended further than that one page asked for: the dashboard's status
  pill was removed rather than reworded, and the "ready"/"not ready" OS
  notifications were either removed or reworded to match, so the rule
  holds consistently across the whole extension, not just the one screen
  it was first stated for. Any new user-facing copy should be checked
  against this before mentioning the underlying tech.

## Non-goals (for now)

- No cloud sync / multi-device support
- No resume or cover letter management
- No email parsing for status updates (e.g. rejection emails)

See [roadmap.md](roadmap.md) for what's planned beyond v0.1.
