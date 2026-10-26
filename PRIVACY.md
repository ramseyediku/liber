# Privacy Policy

_Last updated: 2026-09-28_

Liber ("the extension") is a job application tracker. This document explains
what data it accesses, how it's used, and where it's stored.

## Data collected

When you click something that looks like an "Apply" or "Submit application"
button on a webpage, Liber reads text from that page — either from a popup/
dialog that appears, or from the page itself — and uses an AI model running
entirely on your own device (see "On-device AI model" below) to identify the
job title, company name, and location within it. If an application continues
onto a new page or a new browser tab (common with multi-step application
forms), Liber reads that page too, for up to a few minutes after the click,
so it can keep track of the same application as it progresses — without
requiring you to click Apply again on each step. No page content or
extracted job data is sent anywhere — the model runs locally, the same as
the rest of the extension.

You also optionally provide your name and profession during onboarding.

## Data storage

All data is stored locally on your device using the browser's built-in
`storage.local` API. **Liber does not transmit any job data, page content,
or profile information to an external server** — there is no backend, and
no analytics or tracking are included. Data stays on your device and is
only visible to you, through the extension's dashboard.

Uninstalling the extension removes all locally stored data.

## On-device AI model

Liber uses a small open-source language model ([WebLLM](https://github.com/mlc-ai/web-llm),
running the `Qwen2.5-3B-Instruct` model) to read job application pages and
identify job details, instead of sending anything to a cloud AI service.
This requires downloading the model file (a few gigabytes) once, from its
public hosting provider — this download contains only the model itself, not
any of your data, and the model never contacts that or any other server
again afterward. All extraction happens entirely on your device from that
point on. This currently requires a Chromium-based browser (e.g. Chrome)
with WebGPU support; on an unsupported browser or device, Liber simply
can't extract job details automatically.

## Permissions used

| Permission | Why it's needed |
|---|---|
| `storage` | Save tracked jobs and your profile locally. |
| `activeTab` / `scripting` | Read job details from the page you're applying on, including a page it leads to afterward (a later step or a new tab), while that application is still in progress. |
| `notifications` | Show the "Save this job application?" confirmation prompt. |
| `host_permissions: <all_urls>` | The content script needs to run on any site you might apply to, since job postings live on many different domains. |

## Third parties

Liber does not share, sell, or transmit any collected data to third parties.

## Contact

Questions about this policy can be directed to: `[add contact email before
publishing]`
