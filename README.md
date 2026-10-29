# Besaid Island

Visit it at: https://kiwamasi.github.io/Besaid-Island/

## What's on the site

- **Home** (`index.html`): a grid of game cards. Each card opens that game's guide. There's one so far, for Dark Cloud 2.
- **Dark Cloud 2 Photography & Scoop Log** (`dark_cloud_2_idea_book.html`): a checklist of every Scoop, Idea and Badge in Dark Cloud 2, with a tab per chapter plus a Badges tab. One-shot photos you can miss are flagged in red with the reason. Running totals show points toward Level 8 per chapter and overall. Your ticks are saved in your own browser, and "Clear all checkmarks" resets them.
- **Backlog** (`backlog.html`): games still to play, grouped into PS5, PS3 and Misc and sorted alphabetically, with a search filter and a button per genre that shows only that genre's games. Every account has its own backlog, at `backlog.html?user=<name>`, which anyone can look at and only its owner can change. Without a name in the link, the page shows your own backlog when you're signed in (and adds your name to the address, ready to share), or Kiwamari's when you're not. The heading names the owner, like "Kiwamari's Backlog". On your own backlog, a green "+" at the end of each section opens a slot to type a game name and an optional note (Enter or clicking away adds it, Escape cancels). On each game, the pen reopens that slot to edit it, and the red "−" removes it. Games added to premium accounts' backlogs are given a genre (RPG, Shooter, …) automatically when they're first added; anyone can type one in brackets (see below). Genres show in brackets after the note, like "Replaying on hard (RPG)", or just "(RPG)" with no note.
- **Profile** (`profile.html`): each account's profile, at `profile.html?user=<name>`, picked the same way as the backlog. It shows whether the account is the admin and a premium user, how many games are in its backlog, the storage it uses (its games, with how many there are, and its account record, separately), its Gemini token use today and in total (premium accounts only), and its site colour. Anyone can see any profile.
  - **Colour:** on your own profile, the colour picker sets your site colour. It replaces the trim colour on every page while you're signed in (dragging previews it, letting go saves it), and "Reset to default" goes back to the site's own. Other people see the site in their own colour, or the default.
  - **Premium:** the admin always is. Anyone else is granted or revoked premium by Kiwamari on the Users page (the pen next to their name). Premium is stored with the account on Netlify, and only premium accounts get genres from Gemini.
- **Stats** (`about.html`): site and repository stats. "Recently added" lists the newest games added to anyone's backlog, with whose backlog each is on. The other backlog figures are Kiwamari's.
- **Users** (`users.html`): every account, Kiwamari first, then A–Z. Clicking one opens their profile. Admin and premium accounts are tagged (premium in gold). Signed in as Kiwamari, a pen next to each account opens its settings (premium and colour, plus its games and storage) to change, and can fill in missing genres on its backlog with Gemini (premium accounts only), and a red bin next to each other account deletes it after a Yes/No prompt: the account, its backlog and its settings are all removed, and anyone still signed in to it is signed out. Kiwamari can't be deleted.
- **Browsing someone's pages:** after opening someone's profile or backlog (from the Users page or a shared link), the nav bar's Backlog and Profile links go to that person's pages, until you click Home or pick yourself on the Users page. This lasts for that browser tab only.
- **Accounts** (every page): the "Sign in / Create account" button in the header opens a sign-in box on whichever page you're on. Once signed in, the header shows "Name | Admin | Premium | Sign Out", with Admin and Premium only for accounts that are. Anyone can make an account, which comes with its own backlog and profile. New usernames can't contain invisible characters or read as "Kiwamari" (like "Kiwa_mari"). Kiwamari is the one admin account: only it sees errors on the Stats page, and only it can change or delete other accounts.
- **Who can change what:** every check happens on the Netlify service, never in the page. Admin comes from the signed sign-in token (it can't be made without the `SESSION_SECRET`), and premium from the account's record, which only the admin can change. Changing the page in the browser (showing hidden buttons, editing scripts) only changes what that person sees; the service still refuses anything they aren't allowed to do. A game's "added" time is set by the service too.

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
  - `energy-chart.js`: the half-hourly electricity chart in the profile's admin panel.
  - `users.js`: the users page.
  - `about.js`: the Stats page (from GitHub and from Netlify).
  - `home.js`: the floating hover effect on the home page cards.
- `assets/`: images and icons.
- `netlify/`, `netlify.toml`, `package.json`: the small backlog and account service that runs on Netlify. `netlify/lib/octopus.mjs` is its Octopus Energy part.

### Game genres (Google Gemini)

For premium accounts only, the Netlify service asks Google's Gemini API "what genre is this game?" once per game, when it's added, and saves the answer with the game. The service checks premium on every Gemini request. Other accounts' games have no genre unless one is typed in brackets, so they never use the Gemini quota. Each premium account's own use is counted for its profile page; the Stats page shows the total. Only the game's name is sent, never its note. Editing a game, even renaming it, keeps its genre.

**Changing a genre by hand:** the genre shows in brackets at the end of the note box when editing a game. Change what's in the brackets, e.g. "(Action)" to "(JRPG)", and that becomes the genre, with no Gemini call. Any text works, not just the list below. Deleting the brackets keeps the old genre. Typing a genre in brackets when adding a game skips Gemini for that game too. This means a note ending in brackets, like "Finish it (again)", sets the genre to "again".

Setup:

1. Get a free API key at https://aistudio.google.com/apikey.
2. In Netlify: **Site configuration → Environment variables → Add a variable**, key `GEMINI_API_KEY`, value the key. Then **Deploys → Trigger deploy** so the service picks it up.

The key stays on Netlify; it never goes in this repo or the pages.

- **Model changes:** it uses Google's `gemini-flash-latest` alias (falling back to `gemini-flash-lite-latest`), which Google keeps pointed at their current model, so old models being retired doesn't break it. To pin a specific model instead, set a `GEMINI_MODEL` variable on Netlify.
- **Never after the fact by itself:** Gemini is only asked when a game is first added. Editing a game never asks, and opening a backlog never fills in games that have no genre.
- **If Gemini fails** (no key, rate limit, Google outage, a changed API), games still save, just without a genre, and the error shows on the Stats page. To fill in games missing a genre, Kiwamari opens that account's pen on the Users page and clicks "Fill in with Gemini" (premium accounts only; the use counts as theirs). They're done one at a time: each waits for Gemini's answer (up to 30 seconds), then 15 seconds before the next, to stay under Google's per-minute request limit. It stops if the box is closed, or at the first game Gemini doesn't answer for.
- **Rate limits:** after Google says a model is over its limit (HTTP 429), that model is left alone for 2 minutes. If both models are over, games just wait for the next try.
- **The genre list** is `GAME_CATEGORIES` in `netlify/functions/backlog.mjs`: broad genres only (Action, Action RPG, Adventure, Builder, Fighting, Horror, Platformer, Puzzle, Racing, RPG, Shooter, Souls-Like, Sports). Gemini has to pick one of them, or Other or Simulation, which aren't genres any more: a game Gemini puts there is left without a genre and isn't asked about again. Older games with Other or Simulation, and those typed in brackets, show no genre too. Souls-Like is the one exception to "broad only": Gemini is told to use it for soulslikes such as Dark Souls, Sekiro and Code Vein. Building and sandbox games like Minecraft are Builder. Strategy and tactics games are counted as RPG.
- **Series in one slot:** a name ending in numbers split by slashes, like "Dark Souls 1/2/3", is sent to Gemini without them ("Dark Souls"). The saved name keeps the numbers.
- **Usage:** Google has no API that reports remaining quota, so the service counts its own Gemini calls. The Stats page shows everyone today's requests and tokens, the last 30 days, all time (kept forever), and the last time a Google limit was hit. Days follow Pacific time, when Google resets daily limits. The real limits are on the [AI Studio rate limit page](https://aistudio.google.com/rate-limit). Optionally, set `GEMINI_DAILY_LIMIT` on Netlify to that daily request limit and the Stats page shows "used / limit".

### Electricity (Octopus Energy)

Kiwamari's profile has an admin panel, seen only by Kiwamari. At the top is a live view from the Octopus Home Mini, like the one in the Octopus app: the power being used now, a line of the last hour's demand (hover it, or focus it and use the arrow keys, to read any moment; arrow keys step a minute at a time), and today's use and cost so far. It updates every 30 seconds while the tab is open and visible. Below it are electricity use and costs for today, yesterday, this week, this month and this year, and a half-hourly chart of each of the last 31 days that have readings (previous/next day buttons; hover a column, or focus the chart and use the arrow keys, for its time, kWh and cost; night-rate hours are shaded; "Show as table" lists every half hour). The Netlify service gets them from the [Octopus Energy API](https://developer.octopus.energy/rest/) (`netlify/lib/octopus.mjs`) and refuses anyone but the admin. The API key and meter details stay on Netlify; they never go in this repo or the pages.

Setup: in Netlify, **Site configuration → Environment variables**, add:

- `OCTOPUS_API_KEY`: from the Octopus dashboard, under Personal details → API access.
- `OCTOPUS_MPAN`: the electricity meter's MPAN.
- `OCTOPUS_SERIAL`: the electricity meter's serial number.
- `OCTOPUS_ACCOUNT`: the account number (A-XXXXXXXX). Optional, but costs need it, as it's how the tariff is found. The live view needs it too, to find the Home Mini.
- `OCTOPUS_DEVICE_ID`: optional. The Home Mini's device ID, if it shouldn't be looked up from the account (for instance if the account has more than one).
- `OCTOPUS_NIGHT_HOURS`: for two-rate (Economy 7 style, `E-2R-…`) tariffs only, when the night rate applies, in GMT, like `00:30-07:30` (the default if it's not set). Night hours depend on the meter; they're on the bill or the Octopus app's tariff details. The meter stays on GMT all year, so in summer the night rate is an hour later on the clock.

Then **Deploys → Trigger deploy**.

- **Costs** use the real tariff for every half hour (so Agile and Go are priced right), plus the daily standing charge, with VAT, assuming payment by direct debit. Two-rate tariffs use the night price during `OCTOPUS_NIGHT_HOURS` and the day price otherwise. Costs that couldn't all be priced show with a "~".
- **Today** comes from the Home Mini while it's reporting (labelled "Today (live)"): its use and unit costs, plus the standing charge. Without it, Today is usually empty, as the meter's half-hourly readings reach Octopus about a day later; the panel says how far those go.
- **Live view:** the Home Mini's readings come from Octopus's GraphQL API, which has a reading for about every 10 seconds, usually a minute or so behind. If the newest reading is more than 5 minutes old, the panel says the Home Mini may be offline.
- **Keeping within Octopus's limits:** Octopus only allows so many requests, so:
  - Only a scheduled Netlify job (`netlify/functions/wattnick.mjs`) asks Octopus for Home Mini readings: once a minute, around the clock, only for the readings since the last time, with today's total refreshed at most every 10 minutes in the same request. That's about 60 requests an hour, however many tabs are open. The live view and the Discord bot both use what it saves; the live view asks the Netlify service every 30 seconds, which doesn't reach Octopus.
  - The Octopus sign-in (an hour long) and the Home Mini's ID are saved on Netlify, so it signs in about once an hour and looks the Home Mini up once.
  - If Octopus says "too many requests", the job leaves it alone for 10 minutes, and the live view says until when.
  - The summary (tiles and half-hourly chart) takes about 4 or 5 requests and is kept for 30 minutes. **Refresh** asks again only if it's more than 5 minutes old.

### Discord nickname bot

The admin panel's last section controls a Discord bot that sets Kiwamari's nickname in chosen servers to the Home Mini's reading, like "Kiwamari 1.24kW ⚡" (or "Kiwamari 450W ⚡" under 1 kW). Only Kiwamari sees it, and the Netlify service refuses everyone else.

- **How it runs:** the bot is a Discord application invited to each server. It never stays connected to Discord, so it shows as offline there. Instead, the scheduled Netlify job sets the nickname through Discord's API with the bot's token, using the reading it just saved. It skips Discord when the nickname hasn't changed. Nothing needs to run on a PC.
- **Panel:** Invite to a server, Pause / Resume, the name before the reading (up to 22 characters), your Discord user ID, which servers, how often (every 1 to 60 minutes), and whether to put your name back when paused. It shows the last nickname set and the last error, such as Discord refusing, with a countdown to the next run; it refreshes a few seconds after each run (the job runs at the top of every minute) while the tab is visible, without asking Discord or Octopus. A log console underneath lists the last 50 events: settings changes (paused, resumed, name changed, …), each nickname set, and errors, each logged once when it starts and once when it clears ("Working again").
- **Readings over 10 minutes old** aren't put in a nickname; it's left as it is until the Home Mini is back.

Setup:

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application, then under **Bot** reset and copy its token. The bot's name and avatar are set there too.
2. In Netlify, add `DISCORD_BOT_TOKEN` (the token). Optionally add `DISCORD_CLIENT_ID` (the application ID, under General Information); without it, it's read from the token. Then **Deploys → Trigger deploy**.
3. On your profile, click **Invite to a server** and pick the server. The bot asks only for Manage Nicknames.
4. In that server's **Server Settings → Roles**, drag the bot's role above your highest role. Discord won't let a bot rename someone above it, or the server's owner.
5. Fill in your Discord user ID (Developer Mode under User Settings → Advanced, then right-click your name → Copy User ID), tick the server, Save, then Resume.

If the old `wattnick.py` is still running on a PC, stop it: it would ask Octopus too, on top of the job.

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
- Adding `?mock=off` to the address uses the real backlog instead, and `?mock=on` switches back. The browser remembers the choice. On the live site the stand-in never runs, whatever the address says.
