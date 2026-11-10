# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual job seekers in an active search, applying to many roles across many sites (LinkedIn, Indeed, company career pages, ATS platforms such as Greenhouse and Lever). They mostly use the toolbar popup for quick glances and status updates, and the full-page dashboard for review sessions.

## Product Purpose

Liber is a Manifest V3 browser extension that notices when the user applies to a job and offers to log it, so they keep a running record of every application, with status and notes, without maintaining a spreadsheet. Success is a complete, current application history the user never had to type in.

## Positioning

Zero data entry: capture happens on the apply action on any site, with no per-site setup, and the user only confirms. Nothing is read or sent until the user says yes.

## Operating Context

- Surfaces: toolbar popup (`src/dashboard/dashboard.html`), full-page dashboard (`dashboard-full.html`), onboarding and auth pages (onboarding, login, signup, reset-password), settings page, and an in-page save prompt plus native browser notifications.
- Accounts via Supabase Auth (email/password); jobs and profile (name, target profession) stored in Supabase, protected by row-level security.
- Job details are extracted server-side through a Supabase Edge Function. A short-lived local scrape activity log is viewable in the dashboard.
- Chromium browsers and Firefox (gecko id set, min 115).

## Capabilities and Constraints

- Statuses: Applied, Interviewing, Offer, Rejected, Withdrawn. Inline notes editing, delete.
- Popup must stay within browser popup size limits; layouts cannot assume a large viewport.
- No resume or cover-letter management; no email parsing for status updates (non-goals for now).
- User-facing copy must never use "AI", "LLM" or "model" language; Liber is presented only as a job tracker that "sets up" and "scrapes".

## Brand Commitments

- Keep the current logo (`src/assets/logo.png`, icon set in `src/assets/icons/`).
- Keep the bundled typefaces: Cocogoose, Pangea Text, Twenty One Native (`src/assets/`).

## Evidence on Hand

Real product docs: `docs/product-spec.md`, `docs/architecture.md`, `PRIVACY.md`. No testimonials, customer logos, benchmarks or pricing exist; do not fabricate them.

## Product Principles

- Capture should be effortless; the user confirms rather than types.
- Consent first: never read or send page content before the user agrees.
- Quick to scan: the popup must read at a glance and support fast status changes.
- Plain job-tracker language; the underlying technology stays out of user-facing copy.

## Accessibility & Inclusion

WCAG AA is required: AA contrast, visible focus, and full keyboard operation across popup, dashboard and auth pages.
