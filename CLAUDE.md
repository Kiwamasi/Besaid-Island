# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Besaid Island is a personal gaming site: a game-card home page, a Dark Cloud 2 checklist, and per-account game backlogs, profiles, a users list and a stats page. `README.md` describes every feature in detail from the user's point of view (permissions, Gemini genre rules, Octopus energy panel, setup of environment variables). Read the relevant section there before changing a feature, and keep it updated when behaviour changes.

## Two deploy targets

- **Static site → GitHub Pages** (https://kiwamasi.github.io/Besaid-Island/): the root `*.html` pages, `css/`, `js/`, `assets/`. Plain HTML/CSS/JS, no build step, no framework, no bundler. Pages stay in the repo root so their URLs don't change.
- **API → Netlify** (`netlify.toml`, `package.json`, `netlify/`): one function, `netlify/functions/backlog.mjs`, bundled by esbuild. Its only dependency is `@netlify/blobs`. `netlify/public/index.html` is a placeholder; the site itself is not served from Netlify. The pages find the API through `window.SITE_API_URL` in `js/site-config.js`.

## Commands

There is no build, lint or test suite, and **Node is not installed on this machine** (so no `node --check`, `npm`, or `netlify dev`).

- **Run locally:** open the HTML files directly or serve the folder on `localhost`. `js/local-mock-api.js` then intercepts all API calls and answers them from `localStorage` (starts signed in as admin `kiwamari`; any password signs in as admin). `?mock=off` uses the real Netlify API, `?mock=on` switches back.
- **Syntax-check JS/MJS before handing over**, especially `netlify/functions/backlog.mjs` and `netlify/lib/*.mjs`: parse each file in headless Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe --headless=new --dump-dom` on a scratch page that fetches the file, strips `import`/`export`, and runs `new AsyncFunction(text)` to parse without executing). An unparsed edit once broke the Netlify deploy. Prefer double quotes or template literals for strings containing apostrophes.

## API architecture (`netlify/functions/backlog.mjs`)

- A single default-export handler dispatches on method: `GET` with query-param flags (`?session`, `?stats`, `?whoami`, profile/backlog reads, …), `POST` with `body.action` (`login`, `register`, `view`, `error`, `delete-user`, `update-user`, `clear-errors`, `set-color`, `categorize`; a `POST` with no special action saves a game), and `DELETE` to remove a game.
- **Storage** is Netlify Blobs, always with `consistency: 'strong'`:
  - `public-game-backlog`: games, keyed by owner prefix (`backlogPrefix`) + `game-<id>`.
  - `backlog-accounts`: `user-<name>` account records (scrypt-hashed passwords, `premium`, `createdAt`) and `settings-<name>` (site colour).
  - `site-stats`: page views, errors, Gemini usage (global `gemini` and per-user `gemini-user-<name>`), `recent` additions, cached `energy` summary.
- **Auth:** stateless HMAC-signed bearer tokens (`createSession`/`getSession`, `SESSION_SECRET` ≥ 32 chars). The admin is the fixed username `kiwamari`, whose password is the `BACKLOG_PASSWORD` env var (it has no account record). `activeSession` rejects tokens for deleted accounts or tokens older than the account's `createdAt`. All permission checks live on the server; the client only hides UI.
- **Gemini genres** (`categorizeGame`, `askGemini`, `recordGeminiCall`): premium-only, asked once when a game is added, model fallback list with 429 cooldowns and a total time budget under Netlify's 60 s limit. Genre list is `GAME_CATEGORIES`; `REMOVED_GENRES` mark "no genre".
- **Octopus Energy** lives in `netlify/lib/octopus.mjs`, admin-only. `readEnergySummary` (`?energy`) uses the REST API, cached 30 minutes in `site-stats`. `readLiveEnergy` (`?energy-live`) uses the GraphQL API for the Home Mini's `smartMeterTelemetry`; the profile polls it every 30 s via `js/energy-live.js`. Octopus rate-limits, so keep calls down: the Kraken token and device ID are saved in Blobs (`octopus-auth`), the live answer is saved (`energy-live`) and shared for 25 s and fetched incrementally, a rate-limit error pauses live calls for 10 minutes (HTTP 429), and only auth errors trigger a token renewal and retry.
- Env vars: `SESSION_SECRET`, `BACKLOG_PASSWORD`, `ALLOWED_ORIGIN` (CORS, defaults to the GitHub Pages origin), `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_DAILY_LIMIT`, `OCTOPUS_API_KEY`, `OCTOPUS_MPAN`, `OCTOPUS_SERIAL`, `OCTOPUS_ACCOUNT`, `OCTOPUS_NIGHT_HOURS`, `OCTOPUS_DEVICE_ID`.

**The local mock (`js/local-mock-api.js`) is only for UI design.** It answers with static fake data so pages can be seen and styled locally. Don't mirror server logic in it (caching, rate limits, permissions, call patterns), and don't use it to test or verify server behaviour. When a new endpoint or response field is added, just give the mock fake data in the same shape so the UI renders.

## Front-end architecture

- Every page starts its `<body>` with `<header class="site-header"></header>` and then loads, in this order: `site-header.js` (builds the header and nav from `NAV_LINKS`), `site-config.js`, `local-mock-api.js`, `site-account.js`, `site-telemetry.js`. Page scripts (`backlog.js`, `profile.js`, `users.js`, `about.js`, `home.js`, `energy-chart.js`) load after these. See README "Adding a new page" for the exact `<head>` and `<body>` snippets.
- `window.siteAccount` (documented at the top of `js/site-account.js`) is the shared client API: `status`, `user`, `request(method, body)`, `pageOwner()` (whose backlog/profile a page shows, from `?user=`, the tab's "browsing" state, or the signed-in user), colour helpers. Pages react to the `site-account-change` event.
- **CSS:** `css/site.css` holds theme variables (`--trim-color` is the single accent colour, overridden by the user's chosen colour) plus the header, account controls and dialogs; page stylesheets must not restyle `.site-header`, `.site-nav`, `.site-account` or `.site-dialog`. `css/base.css` is the reset for all pages except the Dark Cloud 2 page, which keeps its styles inline.

## Conventions

- Code comments explain *why* in plain sentences; match that style and density.
- Commit messages are short titles (e.g. "API Bug Fix", "Added Octopus API").
