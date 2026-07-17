# CLAUDE.md

Guidance for working in the **lotcheck** repo — Canada's used-car market intelligence platform.

## What this is

A Vite + React 18 single-page app deployed on Vercel. Supabase is the backend
data store. The user-facing product is "Quote Check" plus market/price tooling
(Deal Score, EVAP rebates, Canadian Black Book estimates, dealer connect).

## Commands

```bash
npm install      # node_modules is NOT committed — install before building
npm run dev      # vite dev server
npm run build    # vite build (production)
npm run preview  # serve the built output locally
```

There is no test script and no linter configured.

## Architecture

Entry chain: `app.html` → `/src/main.jsx` → `src/App.jsx` (mounted on `#root`).

- **`app.html`** — the real app shell and Vite build input (see `vite.config.js`
  `rollupOptions.input.app`). Holds all `<head>` SEO/OG/PWA metadata.
- **`src/App.jsx`** — ~4,700-line monolith. This is where nearly all UI and app
  logic lives; the git history is almost entirely "Update App.jsx" churn. Any
  runtime bug most likely lives here.
- **`src/main.jsx`** — React root bootstrap (StrictMode).
- **`src/scraper.js`**, **`src/verify.js`** — supporting modules.
- **`api/track-visit.js`** — Vercel serverless function (visit tracking).
- **`public/`** — static assets and standalone HTML pages served as-is:
  `lotcheck-landing.html`, `dealer-portal.html`, `canada-map.html`,
  `statcan-zev-map.html`, `privacy.html`, `index.html`, plus `sw.js`
  (service worker), `manifest.json`, icons, and `data/statcan-zev.json`.
- **`github/workflows/update-statcan-zev.yml`** — scheduled job that refreshes
  the StatCan ZEV dataset.

### Key dependencies
`react` 18, `recharts` (charts), `@supabase/supabase-js`, `@vercel/analytics`,
`heic2any` (HEIC image conversion, likely for photo uploads).

## Deployment

Vercel. Routing/headers live in **`vercel.json`** — `/` serves `index.html`,
everything except `/api/*` rewrites to `/app.html`.

## Gotchas (read before editing config)

- **`vercel.json` is the live file. `vercel` (no extension) is a dead shadow
  copy and Vercel ignores it.** They currently disagree: the dead `vercel` file
  rewrites `/(.*) → /app.html`, which would swallow `/api/*` requests. Edit
  `vercel.json` only; consider deleting the extensionless `vercel` file.
- **`vite.config.js` is the live config. `vite.config` (no extension) is a dead
  byte-for-byte shadow** Vite never reads. Edit `vite.config.js` only.
- **`index-NEW-welcome`** (~524 KB, no extension) in the repo root is a leftover
  and is not wired into anything.
- `app.html` references `/icon-152.png` (apple-touch-icon) but `public/` only
  ships icon-96/192/512, so that one icon 404s.

## Conventions

- Locale is Canadian (`en-CA`); copy, pricing, and rebate logic are
  Canada-specific (provinces, Canadian Black Book, federal EVAP rebates).
- Static marketing/utility pages are hand-written HTML in `public/`, separate
  from the React app in `src/`.

## gstack

This project uses gstack for engineering workflow skills, installed at
~/.claude/skills/gstack.

**Web browsing:** Use the /browse skill from gstack for all web browsing.
Never use mcp__claude-in-chrome__* tools.

**Available skills:**
/office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /design-shotgun, /design-html, /review, /ship,
/land-and-deploy, /canary, /benchmark, /browse, /connect-chrome, /qa,
/qa-only, /design-review, /setup-browser-cookies, /setup-deploy,
/setup-gbrain, /retro, /investigate, /document-release, /document-generate,
/codex, /cso, /autoplan, /plan-devex-review, /devex-review, /careful,
/freeze, /guard, /unfreeze, /gstack-upgrade, /learn
