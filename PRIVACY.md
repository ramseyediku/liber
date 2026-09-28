# Privacy Policy

_Last updated: 2026-09-28_

Liber ("the extension") is a job application tracker. This document explains
what data it accesses, how it's used, and where it's stored.

## Data collected

When you click something that looks like an "Apply" or "Submit application"
button on a webpage, Liber reads the following from that page only:

- Job title, company name, location, and a short excerpt of the job
  description (from the current page's DOM)
- The page URL

You also optionally provide your name and profession during onboarding.

## Data storage

All data is stored locally on your device using the browser's built-in
`storage.local` API. **Liber does not transmit any data to an external
server** — there is no backend, and no analytics or tracking are included.
Data stays on your device and is only visible to you, through the extension's
dashboard.

Uninstalling the extension removes all locally stored data.

## Permissions used

| Permission | Why it's needed |
|---|---|
| `storage` | Save tracked jobs and your profile locally. |
| `activeTab` / `scripting` | Read job details from the page you're currently on when you click Apply. |
| `notifications` | Show the "Save this job application?" confirmation prompt. |
| `host_permissions: <all_urls>` | The content script needs to run on any site you might apply to, since job postings live on many different domains. |

## Third parties

Liber does not share, sell, or transmit any collected data to third parties.

## Contact

Questions about this policy can be directed to: `[add contact email before
publishing]`
