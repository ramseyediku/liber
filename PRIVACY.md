# Privacy Policy

_Last updated: 2026-10-31_

Liber ("the extension") is a job application tracker. This document explains
what data it accesses, how it's used, and where it's stored.

## Data collected

When you click something that looks like an "Apply" or "Submit application"
button on a webpage, Liber shows an in-page prompt asking whether to save
that job — nothing is read or sent anywhere until you say yes. If you
confirm, Liber reads a bounded portion of text from that page (either from
a popup/dialog that appears, or from the surrounding page content) and
sends it to identify the job title, company name, and location within it —
see "How job details are extracted" below.

You also provide an email address and password (to create or sign in to
your account) and, optionally, your name and profession during onboarding.

## Data storage

Tracked jobs and your name/profession are stored in your Liber account,
hosted on Supabase (a third-party database/auth provider), tied to the
email address you signed up with. This data is only ever readable by your
own signed-in account — enforced by database access rules (row-level
security), not just by the extension's own UI. A separate, short-lived
activity log (for debugging scraping, viewable in the dashboard's "Scrape
Activity Log") still stays local to your browser (`storage.session`) and
is cleared when the browser closes or you click "Clear."

Deleting your account (contact support, see below) removes your stored
jobs and profile from Supabase. Uninstalling the extension removes the
local activity log but does not delete your account or its data — sign in
again later and it's still there.

## How job details are extracted

When you confirm saving a job, the bounded page text described above is
sent to a server-side function (hosted on Supabase) that forwards it to
Anthropic's Claude API to identify the job title, company, and location.
Anthropic processes this text solely to return that extraction result; see
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy) for
how they handle it. Only the specific bounded text captured for that one
job — never a full page, and never anything beyond what you've already
consented to save — is sent. If a site embeds the job details in a
standard structured format (`JobPosting` markup, common on many job
boards), Liber reads that directly instead, with nothing sent to Claude at
all.

## Permissions used

| Permission | Why it's needed |
|---|---|
| `storage` | Save your session and a short-lived local activity log. |
| `activeTab` | Read job details from the page you're applying on. |
| `notifications` | Show a save-result notification when the in-page prompt can't be shown (e.g. the tab closed). |
| `host_permissions: <all_urls>` | The content script needs to run on any site you might apply to, since job postings live on many different domains; this also covers the extension's own calls to Supabase. |

## Third parties

Liber uses Supabase (database, authentication) and Anthropic's Claude API
(job-field extraction, via a server-side function — see above) to provide
its core functionality. Neither is used for advertising, analytics, or
tracking, and Liber does not otherwise share, sell, or transmit your data
to third parties.

## Contact

Questions about this policy can be directed to: `[add contact email before
publishing]`
