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
- Platform-specific scraping for LinkedIn and Indeed; generic fallback for
  everything else
- Save-confirmation via native browser notification
- Dashboard: list, edit status (Applied / Interviewing / Rejected / Ghosted),
  edit notes inline, delete
- Local-only storage, no account or sync

## Non-goals (for now)

- No cloud sync / multi-device support
- No resume or cover letter management
- No email parsing for status updates (e.g. rejection emails)

See [roadmap.md](roadmap.md) for what's planned beyond v0.1.
