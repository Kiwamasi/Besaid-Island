# Besaid Island

A personal gaming site: game guides and a shared game backlog.

Live at: https://kiwamasi.github.io/Besaid-Island/

## What the site does

- **Home** (`index.html`): a grid of game cards. Each card opens that game's guide. There is currently one, for Dark Cloud 2.
- **Dark Cloud 2 Photography & Scoop Log** (`dark_cloud_2_idea_book.html`): a checklist of every Scoop, Idea and Badge in Dark Cloud 2, split into a tab per chapter plus a Badges tab. One-shot photos you can miss are flagged in red with the reason. Running totals show points toward Level 8 per chapter and overall. Your ticks are saved in your browser only, and "Clear all checkmarks" resets them.
- **Backlog** (`backlog.html`): a shared list of games still to play, grouped into PS5, PS3 and Misc and sorted alphabetically, with a search filter. Everyone sees the same list. Only the admin account can edit it: a green "+" at the end of each section opens a slot to type a game name and an optional note (Enter or clicking away adds it, Escape cancels). On each game, the pen opens the same slot filled in with its name and note to edit them, and the red "−" removes it.
- **Accounts** (every page): the header's "Sign in / Create account" button opens a dialog on whichever page you're on. Anyone can create an account, which is view-only. The admin account (`kiwamari`) can edit the backlog. Sign-in is remembered in the browser until you sign out.

## How it's hosted

- The website itself is static files served by **GitHub Pages** from this repository.
- The backlog and accounts are stored by a **Netlify Function** with **Netlify Blobs** storage (`netlify/functions/backlog.mjs`). The pages call it at the address in `js/site-config.js`.

## Project layout

- `index.html`, `backlog.html`, `dark_cloud_2_idea_book.html`: the pages. They stay in the root so their URLs don't change.
- `css/`
  - `site.css`: shared on every page. Theme colours (as variables at the top), the header, the account controls, dialogs, buttons and form fields.
  - `base.css`: reset and page background for Home and Backlog.
  - `home.css`, `backlog.css`: page-specific styles. The Dark Cloud 2 page keeps its styles inline.
- `js/`
  - `site-header.js`: builds the header and its nav links on every page.
  - `site-config.js`: the API address.
  - `site-account.js`: sign in, create account and sign out, on every page.
  - `local-mock-api.js`: stands in for the API when testing locally (see below).
  - `backlog.js`: the backlog page.
  - `home.js`: the floating hover effect on home page cards.
- `assets/`: images and icons.
- `netlify/`, `netlify.toml`, `package.json`: the Netlify Function. Netlify expects these in the root.

## Adding a page

Link the fonts and `css/site.css` in the `<head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="css/site.css">
```

Then put this at the top of `<body>`:

```html
<header class="site-header"></header>
<script src="js/site-header.js"></script>
<script src="js/site-config.js"></script>
<script src="js/local-mock-api.js"></script>
<script src="js/site-account.js"></script>
```

- **Nav links:** to add, rename or reorder them on every page, edit `NAV_LINKS` in `js/site-header.js`.
- **Shared styling:** `css/site.css` is the only place the header, account controls and dialogs are styled. Don't restyle `.site-header`, `.site-nav`, `.site-account` or `.site-dialog` in page stylesheets, or they'll look different from page to page.
- **Reacting to sign-in:** page scripts read the signed-in user from `window.siteAccount` and listen for the `site-account-change` event. The comment at the top of `js/site-account.js` explains both.

## Netlify setup

Set these environment variables in the Netlify project settings, then redeploy the function:

- `BACKLOG_PASSWORD`: the non-empty password for the admin account. Netlify stores this server-side; never commit it.
- `SESSION_SECRET`: a separate random secret used to sign login tokens. Keep it private and at least 32 characters.
- `ALLOWED_ORIGIN`: optional; defaults to `https://kiwamasi.github.io`.

How accounts and sessions work:

- **Passwords:** non-admin accounts are stored in Netlify Blobs with salted scrypt password hashes. Passwords can be any non-empty value up to 128 characters, and credentials are never returned by the API.
- **Staying signed in:** the browser keeps a signed token in local storage, so accounts stay signed in across browser restarts. Tokens have no time-based expiry. Signing out clears the token from that browser.
- **Invalidating sign-ins:** changing `SESSION_SECRET` signs everyone out. Changing `BACKLOG_PASSWORD` alone does not sign out an existing admin session.
- **Limits:** Netlify plan limits apply.

## Local testing

`js/local-mock-api.js` stands in for the Netlify Function when the site is opened from `localhost`, `127.0.0.1` or `file://`. It answers the same requests with the same responses and errors, but keeps everything in the browser's localStorage. An orange "Local mock API" badge shows when it's active.

- You start signed in as the admin (`Kiwamari | Admin |` in the header), so you can add and remove games straight away. The local backlog starts empty.
- Signing out works like the real site and stays signed out. Sign in as `kiwamari` with any password to become admin again.
- You can register other accounts locally to test the view-only experience.
- To reset, clear the `besaid-mock-*` and `besaid-backlog-*` localStorage keys for the local origin.
- Add `?mock=off` to the URL to use the real API locally, or `?mock=on` to turn the mock back on. The choice is remembered in that browser until you change it.
