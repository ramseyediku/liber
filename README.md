# Liber – Job Application Tracker

Liber is a browser extension that automatically notices when you apply to a
job on any website and offers to log it, so you get a running dashboard of
every application without keeping a spreadsheet by hand.

## How it works

1. **Detect** — a content script watches every page for clicks on
   "Apply" / "Submit application" style buttons and scrapes the job title,
   company, location, and description from the page.
2. **Confirm** — the background service worker shows a browser notification
   asking whether to save the detected job.
3. **Track** — confirmed jobs are stored locally and shown in a dashboard
   (the extension's toolbar popup), where you can update status
   (Applied / Interviewing / Rejected / Ghosted), add notes, or delete
   entries.

See [docs/architecture.md](docs/architecture.md) for the technical
breakdown and [docs/product-spec.md](docs/product-spec.md) for the intended
product behavior.

## Status

Early, pre-release (`v0.1.0`). Platform-specific scraping currently covers
LinkedIn and Indeed, with a generic fallback for other sites. See
[docs/roadmap.md](docs/roadmap.md) for known gaps and what's planned next.

## Installing (development)

This is a Manifest V3 extension with no build step — it loads directly from
source.

**Chrome / Edge / Brave:**
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this repository's root folder

**Firefox:**
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..." and select `manifest.json`

## Project structure

```
liber/
├── src/
│   ├── background/    # service worker: coordinates detection → confirm → save
│   ├── content/        # injected into every page: detects "Apply" clicks, scrapes job data
│   ├── dashboard/       # toolbar popup: job list UI
│   ├── onboarding/      # first-run setup page
│   ├── shared/         # storage.js: single source of truth for reading/writing extension data
│   ├── styles/          # shared base/reset CSS
│   └── assets/          # icons, fonts, images
├── vendor/              # third-party scripts (browser-polyfill)
├── docs/                # product spec, architecture, roadmap
└── manifest.json
```

## License

MIT — see [LICENSE](LICENSE).
