# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Besaid Island is a personal gaming site: a game-card home page, a Dark Cloud 2 checklist, and per-account game backlogs, profiles, a users list and a stats page. `README.md` is deliberately only a short public overview. Keep it that way: never add the owner's personal details, the admin account or profile, the admin-only features (energy panel, Discord bot), environment variables, or how permissions and security work. Feature behaviour is documented in the code comments.

## Two deploy targets

- **Static site → GitHub Pages** (https://kiwamasi.github.io/Besaid-Island/): the root `*.html` pages, `css/`, `js/`, `assets/`. Plain HTML/CSS/JS, no build step, no framework, no bundler. Pages stay in the repo root so their URLs don't change.
- **API → Netlify** (`netlify.toml`, `package.json`, `netlify/`): the API function `netlify/functions/backlog.mjs` plus the scheduled function `netlify/functions/wattnick.mjs` (every minute), bundled by esbuild. Its only dependency is `@netlify/blobs`. `netlify/public/index.html` is a placeholder; the site itself is not served from Netlify. The pages find the API through `window.SITE_API_URL` in `js/site-config.js`.

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
- **Octopus Energy** lives in `netlify/lib/octopus.mjs`, admin-only. `readEnergySummary` (`?energy`) uses the REST API, cached 30 minutes in `site-stats`. `readLiveEnergy` uses the GraphQL API for the Home Mini's `smartMeterTelemetry` and is called only by the scheduled job, once a minute; `?energy-live` returns the saved answer via `readSavedLive` and never calls Octopus (the profile polls it via `js/energy-live.js` 6 s after each minute's run, like `js/discord-bot.js`, so the graph and nickname show the same reading). After the nickname, the job calls `updateEnergyHistory` when `readLiveEnergy` says `historyDue` (from `historyDueAt` in the `energy-live` blob, so off minutes cost no reads): five-minute readings back up to a year in `energy-history`, one request per update, first on the first run, then every 5 minutes while backfilling 3-day chunks (halved if Octopus refuses) and every 15 once complete. `?energy-history=YYYY-MM-DD` serves one UK day plus the list of days for the live chart's "All" tab. The job also calls `archiveTenSeconds` when `archiveDue` (`archiveDueAt` in `energy-live`): every finished day's 10-second readings go in the separate `energy-archive` store as `ten-seconds/YYYY-MM-DD` (written once, kept for good), one day per request 5 minutes apart. The first run searches back until Octopus has two empty days running (up to 2 years); then it's checked weekly. Progress is `energy-archive-state` in `site-stats`, shown in the "All" tab's note. The live panel's Pause (`POST energy-settings`, `setLivePaused`) sets `paused` inside the `energy-live` blob, so the job needs no extra read: while paused, `readLiveEnergy` throws `LivePaused` and the history is skipped. Octopus allows about 100 requests an hour, so keep calls down: the Kraken token and device ID are saved in Blobs (`octopus-auth`), the live answer (`energy-live`) is fetched incrementally, a rate-limit error pauses calls for 10 minutes, and only auth errors trigger a token renewal and retry. GraphQL gotchas: `TelemetryGrouping` has no `THIRTY_MINUTES` (use `FIVE_MINUTES`), and declared-but-unused variables are rejected.
- **Discord nickname bot** lives in `netlify/lib/wattnick.mjs`, admin-only: the scheduled job sets the nickname via Discord's REST API (`PATCH /guilds/{id}/members/{user}`, bot token `DISCORD_BOT_TOKEN`), with no gateway connection. Settings (`wattnick-settings`) and status (`wattnick-status`) are in the stats store; the profile panel is `js/discord-bot.js` (`?wattnick`, `POST wattnick-settings`).
- **Debug log** (`netlify/lib/debug-log.mjs`, `js/debug-log.js`): the admin panel's Debug box. `recordCall` notes each Octopus/Discord/Gemini request and `recordedStore` wraps Blobs stores (backlog.mjs's `getStore` always returns one). Page requests carry `X-Debug: 1` while it's on, and an admin's answer then includes `_debug` (that request's calls). The scheduled job saves its calls under `debug-log` only while `debugUntil` (in `energy-live`, set by `POST debug`, one hour, renewed by the page) hasn't passed; `?energy-live` adds them as `jobLog`. New outside requests should call `recordCall`.
- Env vars: `SESSION_SECRET`, `BACKLOG_PASSWORD`, `ALLOWED_ORIGIN` (CORS, defaults to the GitHub Pages origin), `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_DAILY_LIMIT`, `OCTOPUS_API_KEY`, `OCTOPUS_MPAN`, `OCTOPUS_SERIAL`, `OCTOPUS_ACCOUNT`, `OCTOPUS_DEVICE_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`.

**The local mock (`js/local-mock-api.js`) is only for UI design.** It answers with static fake data so pages can be seen and styled locally. Don't mirror server logic in it (caching, rate limits, permissions, call patterns), and don't use it to test or verify server behaviour. When a new endpoint or response field is added, just give the mock fake data in the same shape so the UI renders.

## Front-end architecture

- Every page starts its `<body>` with `<header class="site-header"></header>` and then loads, in this order: `site-header.js` (builds the header and nav from `NAV_LINKS`), `site-config.js`, `local-mock-api.js`, `site-account.js`, `site-telemetry.js`. Page scripts (`backlog.js`, `profile.js`, `users.js`, `about.js`, `home.js`, `energy-chart.js`) load after these. A new page's `<head>` links the Google Fonts (Marcellus, IBM Plex Sans 400/500/600) and `css/site.css`, and gets its link in `NAV_LINKS`.
- `window.siteAccount` (documented at the top of `js/site-account.js`) is the shared client API: `status`, `user`, `request(method, body)`, `pageOwner()` (whose backlog/profile a page shows, from `?user=`, the tab's "browsing" state, or the signed-in user), colour helpers. Pages react to the `site-account-change` event.
- **CSS:** `css/site.css` holds theme variables (`--trim-color` is the single accent colour, overridden by the user's chosen colour) plus the header, account controls and dialogs; page stylesheets must not restyle `.site-header`, `.site-nav`, `.site-account` or `.site-dialog`. `css/base.css` is the reset for all pages except the Dark Cloud 2 page, which keeps its styles inline.

## Conventions

- Code comments explain *why* in plain sentences; match that style and density.
- Commit messages are short titles (e.g. "API Bug Fix", "Added Octopus API").
