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
3. **Track** — confirmed jobs are saved to your account (Supabase) and
   shown in a dashboard (the extension's toolbar popup), where you can
   update status (Applied / Interviewing / Offer / Rejected / Withdrawn),
   add notes, or delete entries.

See [docs/architecture.md](docs/architecture.md) for the technical
breakdown and [docs/product-spec.md](docs/product-spec.md) for the intended
product behavior.

## Status

Early, pre-release (`v0.1.0`). Platform-specific scraping currently covers
LinkedIn and Indeed, with a generic fallback for other sites. See
[docs/roadmap.md](docs/roadmap.md) for known gaps and what's planned next.

## Setup (Supabase + Claude)

Liber needs a Supabase project (Postgres + Auth) and a Claude API key
before it'll actually save anything:

1. Copy `.env.example` to `.env` and fill in `SUPABASE_URL`/
   `SUPABASE_ANON_KEY` from your Supabase project (both safe to ship
   client-side — row-level security protects the data, not secrecy of the
   anon key).
2. Run `npm install` once, then `npm run config` — this generates
   `src/shared/env.js` from `.env`, which the extension actually imports.
   Re-run `npm run config` any time `.env` changes.
3. Set `ANTHROPIC_API_KEY` as a **Supabase project secret**
   (`supabase secrets set ANTHROPIC_API_KEY=sk-ant-...`), never in `.env`
   — it's read only by the Edge Function, server-side, and never ships
   inside the extension. See `docs/architecture.md`'s `extraction.js`
   section for why.
4. Apply the project's Supabase schema and deploy the extraction Edge
   Function (both maintained on the Supabase project, not in this repo).

## Installing (development)

This is a Manifest V3 extension with no build step at runtime — it loads
directly from source once the setup above has generated
`src/shared/env.js`.

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
│   ├── onboarding/      # first-run sign-up/sign-in + profile page
│   ├── shared/         # storage.js (Supabase-backed data), supabaseClient.js,
│   │                   # extraction.js (Claude API via a Supabase Edge Function),
│   │                   # env.js (generated, gitignored — see Setup below)
│   ├── styles/          # shared base/reset CSS
│   └── assets/          # icons, fonts, images
├── vendor/              # third-party scripts (browser-polyfill, a bundled supabase-js)
├── scripts/             # generate-config.js — turns .env into src/shared/env.js
├── docs/                # product spec, architecture, roadmap
└── manifest.json
```

## License

MIT — see [LICENSE](LICENSE).
