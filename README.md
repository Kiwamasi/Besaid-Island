# Besaid Island

Visit it at: https://kiwamasi.github.io/Besaid-Island/

## What's on the site

- **Home** (`index.html`): a grid of game cards. Each card opens that game's guide. There's one so far, for Dark Cloud 2.
- **Dark Cloud 2 Photography & Scoop Log** (`dark_cloud_2_idea_book.html`): a checklist of every Scoop, Idea and Badge in Dark Cloud 2, with a tab per chapter plus a Badges tab. One-shot photos you can miss are flagged in red with the reason. Running totals show points toward Level 8 per chapter and overall. Your ticks are saved in your own browser, and "Clear all checkmarks" resets them.
- **Backlog** (`backlog.html`): the games I still want to play, grouped into PS5, PS3 and Misc and sorted alphabetically, with a search filter. Anyone can look; only I can change it. For me, a green "+" at the end of each section opens a slot to type a game name and an optional note (Enter or clicking away adds it, Escape cancels). On each game, the pen reopens that slot to edit it, and the red "−" removes it.
- **Accounts** (every page): the "Sign in / Create account" button in the header opens a sign-in box on whichever page you're on. Anyone can make an account, which can view everything but not edit.

## How it's put together

The site is plain HTML, CSS and JavaScript, hosted on **GitHub Pages**. The shared backlog and the accounts are kept on **Netlify**, which the pages talk to behind the scenes.

### Project layout

- `index.html`, `backlog.html`, `about.html`, `dark_cloud_2_idea_book.html`: the pages. About shows the site stats. They stay in the root so their addresses don't change.
- `css/`
  - `site.css`: shared by every page. The theme colours (as variables at the top), the header, the account controls, dialogs, buttons and form fields.
  - `base.css`: the reset and page background for Home and Backlog.
  - `home.css`, `backlog.css`, `about.css`: page-specific styles. The Dark Cloud 2 page keeps its styles inline.
- `js/`
  - `site-header.js`: builds the header and its nav links on every page.
  - `site-config.js`: where the pages find the backlog and accounts on Netlify.
  - `site-account.js`: signing in, creating an account and signing out, on every page.
  - `site-telemetry.js`: counts page views and reports JavaScript errors for the About page stats, on every page.
  - `local-mock-api.js`: a stand-in for Netlify while testing changes locally (see below).
  - `backlog.js`: the backlog page.
  - `about.js`: the About page stats (from GitHub and from Netlify).
  - `home.js`: the floating hover effect on the home page cards.
- `assets/`: images and icons.
- `netlify/`, `netlify.toml`, `package.json`: the small backlog and account service that runs on Netlify.

### Adding a new page

Every page shares the same header, colours and sign-in. A new page links the fonts and `css/site.css` in its `<head>`:

```html
<link href="https://fonts.googleapis.com/css2?family=Marcellus&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="css/site.css">
```

and starts its `<body>` with:

```html
<header class="site-header"></header>
<script src="js/site-header.js"></script>
<script src="js/site-config.js"></script>
<script src="js/local-mock-api.js"></script>
<script src="js/site-account.js"></script>
<script src="js/site-telemetry.js"></script>
```

- **Nav links:** `NAV_LINKS` in `js/site-header.js` is the one list of links, used on every page.
- **Shared styling:** the header, account controls and dialogs are styled only in `css/site.css`, so they look the same everywhere. Page stylesheets leave `.site-header`, `.site-nav`, `.site-account` and `.site-dialog` alone.
- **Reacting to sign-in:** a page script can read who's signed in from `window.siteAccount` and listen for the `site-account-change` event. The comment at the top of `js/site-account.js` explains both.

## Testing changes locally

When the site is opened from `localhost` or straight from the files on disk, `js/local-mock-api.js` stands in for Netlify. New ideas can then be tried without touching the real backlog. Everything is kept in that browser only, and an orange "Local mock API" badge shows while it's active.

- The local copy starts signed in as admin with an empty backlog, ready for adding, editing and removing games.
- View-only accounts can be created locally to see the site as a visitor would.
- Clearing the browser's stored data for the local site resets it.
- Adding `?mock=off` to the address uses the real backlog instead, and `?mock=on` switches back. The browser remembers the choice.
