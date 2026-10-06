# Besaid Island

Visit it at: https://kiwamasi.github.io/Besaid-Island/

## What's on the site

- **Home** (`index.html`): a grid of game cards. Each card opens that game's guide. There's one so far, for Dark Cloud 2.
- **Dark Cloud 2 Photography & Scoop Log** (`dark_cloud_2_idea_book.html`): a checklist of every Scoop, Idea and Badge in Dark Cloud 2, with a tab per chapter plus a Badges tab. One-shot photos you can miss are flagged in red with the reason. Running totals show points toward Level 8 per chapter and overall. Your ticks are saved in your own browser, and "Clear all checkmarks" resets them.
- **Backlog** (`backlog.html`): games still to play, grouped into PS5, PS3 and Misc and sorted alphabetically, with a search filter and a button per genre that shows only that genre's games. Every account has its own backlog, at `backlog.html?user=<name>`, which anyone can look at and only its owner can change. Without a name in the link, the page shows your own backlog when you're signed in (and adds your name to the address, ready to share), or Kiwamari's when you're not. The heading names the owner, like "Kiwamari's Backlog". On your own backlog, a green "+" at the end of each section opens a slot to type a game name and an optional note (Enter or clicking away adds it, Escape cancels). On each game, the pen reopens that slot to edit it, and the red "−" removes it. Games on Kiwamari's backlog are given a genre (RPG, Shooter, …) automatically when they're saved; anyone can type one in brackets (see below). Genres show in brackets after the note, like "Replaying on hard (RPG)", or just "(RPG)" with no note.
- **Profile** (`profile.html`): each account's profile, at `profile.html?user=<name>`, picked the same way as the backlog. It shows whether the account is the admin and a premium user, how many games are in its backlog, the storage it uses (its games and its account record, separately), and its site colour. Anyone can see any profile.
  - **Colour:** on your own profile, the colour picker sets your site colour. It replaces the trim colour on every page while you're signed in (dragging previews it, letting go saves it), and "Reset to default" goes back to the site's own. Other people see the site in their own colour, or the default.
  - **Premium:** the admin always is. For anyone else, there's no button yet: add `"premium": true` to their account's record in the `backlog-accounts` store on Netlify.
- **Users** (`users.html`): every account, Kiwamari first, then A–Z. Clicking one opens their profile. Signed in as Kiwamari, a red bin next to each other account deletes it after a Yes/No prompt: the account, its backlog and its settings are all removed, and anyone still signed in to it is signed out. Kiwamari can't be deleted.
- **Browsing someone's pages:** after opening someone's profile or backlog (from the Users page or a shared link), the nav bar's Backlog and Profile links go to that person's pages, until you click Home or pick yourself on the Users page. This lasts for that browser tab only.
- **Accounts** (every page): the "Sign in / Create account" button in the header opens a sign-in box on whichever page you're on. Anyone can make an account, which comes with its own backlog and profile. Kiwamari is the one admin account: only it gets automatic genres from Gemini, and only it sees errors and Gemini usage on the Stats page.

## How it's put together

The site is plain HTML, CSS and JavaScript, hosted on **GitHub Pages**. The shared backlog and the accounts are kept on **Netlify**, which the pages talk to behind the scenes.

### Project layout

- `index.html`, `backlog.html`, `profile.html`, `users.html`, `about.html`, `dark_cloud_2_idea_book.html`: the pages. `about.html` is the Stats page. They stay in the root so their addresses don't change.
- `css/`
  - `site.css`: shared by every page. The theme colours (as variables at the top, starting with `--trim-color`, the one accent colour used for hovers, highlights and bars on every page, Dark Cloud 2 included), the header, the account controls, dialogs, buttons and form fields.
  - `base.css`: the reset and page background for Home, Backlog, Profile, Users and Stats.
  - `home.css`, `backlog.css`, `profile.css`, `users.css`, `about.css`: page-specific styles. The Dark Cloud 2 page keeps its styles inline.
- `js/`
  - `site-header.js`: builds the header and its nav links on every page, including pointing Backlog and Profile at the person being viewed.
  - `site-config.js`: where the pages find the backlog and accounts on Netlify.
  - `site-account.js`: signing in, creating an account and signing out, on every page. Also works out whose backlog or profile a page shows.
  - `site-telemetry.js`: counts page views and reports JavaScript errors for the Stats page, on every page.
  - `local-mock-api.js`: a stand-in for Netlify while testing changes locally (see below).
  - `backlog.js`: the backlog page.
  - `profile.js`: the profile page.
  - `users.js`: the users page.
  - `about.js`: the Stats page (from GitHub and from Netlify).
  - `home.js`: the floating hover effect on the home page cards.
- `assets/`: images and icons.
- `netlify/`, `netlify.toml`, `package.json`: the small backlog and account service that runs on Netlify.

### Game genres (Google Gemini)

For Kiwamari's backlog only, the Netlify service asks Google's Gemini API "what genre is this game?" once per game, when it's added, and saves the answer with the game. Other accounts' games have no genre unless one is typed in brackets, so they never use the Gemini quota. Only the game's name is sent, never its note. Editing a game, even renaming it, keeps its genre.

**Changing a genre by hand:** the genre shows in brackets at the end of the note box when editing a game. Change what's in the brackets, e.g. "(Action)" to "(JRPG)", and that becomes the genre, with no Gemini call. Any text works, not just the list below. Deleting the brackets keeps the old genre. Typing a genre in brackets when adding a game skips Gemini for that game too. This means a note ending in brackets, like "Finish it (again)", sets the genre to "again".

Setup:

1. Get a free API key at https://aistudio.google.com/apikey.
2. In Netlify: **Site configuration → Environment variables → Add a variable**, key `GEMINI_API_KEY`, value the key. Then **Deploys → Trigger deploy** so the service picks it up.

The key stays on Netlify; it never goes in this repo or the pages.

- **Model changes:** it uses Google's `gemini-flash-latest` alias (falling back to `gemini-flash-lite-latest`), which Google keeps pointed at their current model, so old models being retired doesn't break it. To pin a specific model instead, set a `GEMINI_MODEL` variable on Netlify.
- **If Gemini fails** (no key, rate limit, Google outage, a changed API), games still save, just without a genre, and the error shows on the Stats page. Next time I open the backlog, games missing a genre are filled in one at a time: each waits for Gemini's answer (up to 30 seconds), then 15 seconds before the next, to stay under Google's per-minute request limit.
- **Rate limits:** after Google says a model is over its limit (HTTP 429), that model is left alone for 2 minutes. If both models are over, games just wait for the next try.
- **The genre list** is `GAME_CATEGORIES` in `netlify/functions/backlog.mjs`: broad genres only (Action, Action RPG, Adventure, Builder, Fighting, Horror, Platformer, Puzzle, Racing, RPG, Shooter, Souls-Like, Sports). Gemini has to pick one of them, or Other or Simulation, which aren't genres any more: a game Gemini puts there is left without a genre and isn't asked about again. Older games with Other or Simulation, and those typed in brackets, show no genre too. Souls-Like is the one exception to "broad only": Gemini is told to use it for soulslikes such as Dark Souls, Sekiro and Code Vein. Building and sandbox games like Minecraft are Builder. Strategy and tactics games are counted as RPG.
- **Series in one slot:** a name ending in numbers split by slashes, like "Dark Souls 1/2/3", is sent to Gemini without them ("Dark Souls"). The saved name keeps the numbers.
- **Usage:** Google has no API that reports remaining quota, so the service counts its own Gemini calls. When I'm signed in, the Stats page shows today's requests and tokens, the last 30 days, all time (kept forever), and the last time a Google limit was hit. Days follow Pacific time, when Google resets daily limits. The real limits are on the [AI Studio rate limit page](https://aistudio.google.com/rate-limit). Optionally, set `GEMINI_DAILY_LIMIT` on Netlify to that daily request limit and the Stats page shows "used / limit".

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

- The local copy starts signed in as admin with an empty backlog, ready for adding, editing and removing games. Profile colours are saved in the browser too.
- Other accounts can be created locally, each with its own backlog and profile, to try sharing links and see the site as someone else would. Signing in as "kiwamari" with any password makes you admin again.
- Clearing the browser's stored data for the local site resets it.
- Adding `?mock=off` to the address uses the real backlog instead, and `?mock=on` switches back. The browser remembers the choice.
