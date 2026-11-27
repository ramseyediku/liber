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

1. **First install** — user is taken to the welcome page, enters their name and
   (optionally) the role they are applying for; the role becomes their first
   job profile. No account is needed: they are a guest. Someone who already has
   an account uses the "Already have an account? Log in" link instead.
2. **Applying** — user clicks "Apply" (or similar) on any job site. Liber
   detects this and captures the job's page content.
3. **Confirm** — a large prompt at the top centre of the page asks "Save this
   job to your tracker?". A new Apply click replaces any prompt already showing.
   Nothing is read or sent until they say yes.
4. **Track** — saved jobs appear in the dashboard (toolbar popup and full page),
   where the user can update status, add notes, or delete an entry for good.
5. **Optionally sign up / sync** — signing up upgrades the guest account in place;
   turning on Cloud Sync uploads the device's data (asking which version wins if
   it differs from the cloud). Without sync, data never leaves the device.

## Feature set (current, v0.1)

- Automatic apply-click detection on any site (heuristic keyword matching)
- Site-agnostic scraping via the Claude API, called through a Supabase Edge
  Function (no API key ships inside the extension — see
  `docs/architecture.md`'s `extraction.js` section) — works across sites
  without a per-site selector table, trading some accuracy for coverage. A
  first step toward the trained classifier planned for v2/v3 (see
  roadmap.md). No longer tied to WebGPU/device capability, since extraction
  runs server-side.
- Save-confirmation prompt on the page (native notification only as a fallback)
- Capture cost control: the page's own structured data first, then a site
  structure learned on an earlier visit (selectors, picking the match nearest the
  Apply button clicked), then Claude. See `docs/architecture.md`.
- Dashboard: list (9 per page, pagination in a fixed position), status filter
  pills with counts, search, edit status (Applied / Interviewing / Offer /
  Rejected / Withdrawn), notes, and delete (a real delete after a short undo
  window)
- Add an application by hand from the dashboard (company, title, location,
  date, status, link, notes)
- Import applications from a CSV (a Liber export or your own spreadsheet) in
  Settings. Free accounts may import past the 10-save limit; imported jobs
  count towards it, so the next save after that is refused.
- Job profiles: group applications by the role being sought; the dashboard shows
  the active profile's jobs and a dropdown switches between them
- Accounts via Supabase Auth (email/password, no email confirmation). Guests are
  upgraded in place when they sign up.
- **Local-first data.** Jobs and profiles live on the device; Cloud Sync (off by
  default, needs an account) is the only thing that sends them to Supabase.
- Plans: Free (10 saves, one job profile, 10 automatic captures) and Premium
  (£3.99 one-time, no limits). Checkout is built but waits on Stripe secrets.
- First-run tour of the dashboard; a developer-only capture log button on the
  dashboard showing how each capture was resolved

## Design principles

- **No "AI"/"LLM"/"model" language anywhere in user-facing text.** Liber is
  presented to the user only as a job tracker that "sets up" and "scrapes"
  — never as an AI product, regardless of what runs under the hood
  (currently the Claude API, called server-side via a Supabase Edge
  Function — previously an on-device LLM via WebLLM; see
  `docs/architecture.md`). This was set as an explicit rule for the old
  post-signup setup page (see `docs/roadmap.md`'s "Post-signup setup page")
  and then deliberately extended further than that one page asked for: the
  dashboard's status pill was removed rather than reworded, and the
  "ready"/"not ready" OS notifications were either removed or reworded to
  match, so the rule holds consistently across the whole extension, not
  just the one screen it was first stated for. Any new user-facing copy
  should be checked against this before mentioning the underlying tech.

### Interface decisions

Decisions made while building the v2 interface, stated as the rules to keep, with
the user's own reason where one was given:

- **One corner radius for everything** (`--border-radius`, currently 0.75rem). It
  began as "the least prominent existing radius wins" (the smallest one in use) and
  was then tuned upward by experiment. Circles (avatars, dots, the toggle) are
  exempt.
- **Popovers:** clicking away closes one; clicking the button of a popover that is
  already open does nothing (it neither closes nor re-opens it, so the open
  animation doesn't replay).
- **Table/pagination:** 9 rows per page in a table of fixed height so the
  pagination never moves between pages; the status pills, search and the table
  headers stay visible even with no applications.
- **Settings** is a row of pill tabs (Profile, Plan, Account & Data, and a
  developer tab on unpacked installs), modelled on a reference screen the user
  supplied; the Plan tab on a plans screen they supplied. Cloud sync lives in the
  profile popover, not the sidebar.
- **Login/signup pages fit the window with no vertical scrolling**, centred, with
  spacing that scales with the window height (checked in headless Chrome at common
  laptop sizes).
- **The tour is kept short** so it doesn't overwhelm new users (the user's concern):
  the page as a whole, job profiles, table, status pills, search, Settings — and a
  one-step "you're using a guest account" note for guests only.
- **Fewer calls (the user's rule):** edits are applied locally and sent to Supabase
  in batches, only with sync on; re-renders read the local cache.
- **"Waiting N days"** turns red from 90 days (amber from 14).
- **Form checks:** the green tick (and green outline) appears on the email field
  only; password fields have none.

## Non-goals (for now)

- No resume or cover letter management
- No email parsing for status updates (e.g. rejection emails)

**Reversed, not a non-goal anymore:** v0.1 originally listed "no cloud sync
/ multi-device support" and "local-only storage, no account or sync" here.
Both were deliberately reversed in the Claude API + Supabase migration (see
`docs/roadmap.md`) — data now lives in Supabase behind real accounts. Kept
here as a record of the reversal, not because it's still true.

See [roadmap.md](roadmap.md) for what's planned beyond v0.1.
