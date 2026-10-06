// Stats page (about.html): site stats laid out like a GitHub repository page.
// - Repository, deployments, commits and languages come from the public GitHub API.
//   They're cached in this browser for 10 minutes to stay well under GitHub's limit
//   of 60 requests an hour per visitor.
// - Page views, accounts and errors come from the site API (netlify/functions/backlog.mjs),
//   counted by js/site-telemetry.js. Errors are only sent to the admin.
// - Gemini usage (shown to everyone) is the site API's own count of its calls to Google
//   for game genres. Google has no API for remaining quota; AI Studio shows the real limits.
const account = window.siteAccount;
const REPO = 'Kiwamasi/Besaid-Island';
const GITHUB_API = `https://api.github.com/repos/${REPO}`;
const GITHUB_CACHE_KEY = 'besaid-github-stats';
const GITHUB_CACHE_MS = 10 * 60 * 1000;
const DAY_MS = 86400000;
// GitHub's own language colours.
const LANGUAGE_COLORS = { HTML: '#e34c26', CSS: '#663399', JavaScript: '#f1e05a' };
const PAGE_NAMES = {
  'index.html': 'Home',
  'backlog.html': 'Backlog',
  'about.html': 'Stats',
  'dark_cloud_2_idea_book.html': 'Dark Cloud 2 idea book'
};
const SYSTEM_ORDER = ['PS5', 'PS3', 'Misc'];

const ICONS = {
  success: '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm3.28 5.22a.75.75 0 0 0-1.06 0L7 8.44 5.78 7.22a.75.75 0 0 0-1.06 1.06l1.75 1.75a.75.75 0 0 0 1.06 0l3.75-3.75a.75.75 0 0 0 0-1.06Z"/>',
  failure: '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM5.78 4.72a.75.75 0 0 0-1.06 1.06L6.94 8l-2.22 2.22a.75.75 0 1 0 1.06 1.06L8 9.06l2.22 2.22a.75.75 0 1 0 1.06-1.06L9.06 8l2.22-2.22a.75.75 0 0 0-1.06-1.06L8 6.94Z"/>',
  pending: '<path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0Zm0 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/>',
  commit: '<path d="M11.93 8.5a4 4 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4 4 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z"/>',
  alert: '<path d="M6.46 1.05a1.75 1.75 0 0 1 3.08 0l6.25 11.5A1.75 1.75 0 0 1 14.25 15H1.75a1.75 1.75 0 0 1-1.54-2.45ZM8 5a.75.75 0 0 0-.75.75v2.5a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 8 5Zm1 6a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z"/>'
};

const $ = id => document.getElementById(id);
const numberFormat = new Intl.NumberFormat();
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

// Everything is built with textContent, never innerHTML, because error messages
// and game titles come from visitors.
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `icon ${className || ''}`);
  svg.setAttribute('fill', 'currentColor');
  svg.innerHTML = ICONS[name];
  return svg;
}

function link(href, className, text) {
  const anchor = el('a', className, text);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener';
  return anchor;
}

function timeAgo(date) {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

function timeElement(date) {
  const time = el('time', '', timeAgo(date));
  time.dateTime = new Date(date).toISOString();
  time.title = new Date(date).toLocaleString();
  return time;
}

function duration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function firstLine(text) {
  return String(text || '').split('\n')[0];
}

function showEmpty(list, text) {
  list.replaceChildren(el('li', 'stats-empty', text));
}

function listRow(iconElement, title, meta, aside) {
  const item = el('li', 'stats-row');
  const body = el('div', 'stats-row-body');
  body.append(title, meta);
  item.append(iconElement, body);
  if (aside) item.append(aside);
  return item;
}

// Label, count and a bar scaled to the largest count, like GitHub's insights lists.
function renderBars(list, entries, emptyText) {
  if (!entries.length) return showEmpty(list, emptyText);
  const max = Math.max(...entries.map(([, count]) => count));
  list.replaceChildren(...entries.map(([label, count]) => {
    const item = el('li', 'bar-row');
    const bar = el('span', 'bar-fill');
    bar.style.width = `${(count / max) * 100}%`;
    item.append(el('span', 'bar-label', label), el('span', 'bar-count', numberFormat.format(count)), bar);
    return item;
  }));
}

// ---------- GitHub ----------

async function githubJson(path) {
  const response = await fetch(`${GITHUB_API}${path}`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) {
    throw new Error(response.status === 403 || response.status === 429
      ? 'GitHub rate limit reached, try again later'
      : `GitHub returned HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchGithub() {
  try {
    const cached = JSON.parse(localStorage.getItem(GITHUB_CACHE_KEY));
    if (cached && Date.now() - cached.savedAt < GITHUB_CACHE_MS) return cached.data;
  } catch {
    // No usable cache; fetch fresh.
  }

  const [repo, commits, runs, languages] = await Promise.all([
    githubJson(''),
    githubJson('/commits?per_page=6'),
    githubJson('/actions/runs?per_page=6'),
    githubJson('/languages')
  ]);
  // Only the fields shown here; commit author emails are left out.
  const data = {
    repo: { description: repo.description, createdAt: repo.created_at, pushedAt: repo.pushed_at },
    commits: commits.map(commit => ({
      sha: commit.sha,
      message: firstLine(commit.commit.message),
      author: commit.author?.login || commit.commit.author?.name || 'unknown',
      date: commit.commit.author?.date,
      url: commit.html_url
    })),
    runs: runs.workflow_runs.map(run => ({
      name: run.name,
      number: run.run_number,
      status: run.status,
      conclusion: run.conclusion,
      message: firstLine(run.head_commit?.message || run.display_title),
      branch: run.head_branch,
      startedAt: run.run_started_at,
      updatedAt: run.updated_at,
      url: run.html_url
    })),
    deployCount: runs.total_count,
    languages
  };
  try {
    localStorage.setItem(GITHUB_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Storage full or blocked; the page still works, it just re-fetches next time.
  }
  return data;
}

function renderRepo({ repo, deployCount, runs }) {
  const meta = $('repoMeta');
  meta.replaceChildren();
  if (repo.description) meta.append(el('span', 'stats-repo-description', repo.description));
  const latest = runs.find(run => run.status === 'completed');
  meta.append(
    el('span', '', 'Updated '), timeElement(repo.pushedAt),
    el('span', 'stats-dot-sep', '·'),
    el('span', '', `${numberFormat.format(deployCount)} deployments`),
    el('span', 'stats-dot-sep', '·'),
    el('span', '', `Started ${new Date(repo.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`)
  );
  if (latest) {
    meta.append(el('span', 'stats-dot-sep', '·'), el('span', '', `Last deploy ${latest.conclusion === 'success' ? 'succeeded' : latest.conclusion}`));
  }
}

function renderDeploys(runs) {
  const list = $('deploysList');
  if (!runs.length) return showEmpty(list, 'No deployments yet.');
  list.replaceChildren(...runs.map(run => {
    const state = run.status !== 'completed' ? 'pending' : run.conclusion === 'success' ? 'success' : 'failure';
    const aside = el('div', 'stats-row-aside');
    aside.append(timeElement(run.updatedAt));
    if (run.status === 'completed') {
      aside.append(el('span', 'stats-muted', duration(new Date(run.updatedAt) - new Date(run.startedAt))));
    } else {
      aside.append(el('span', 'stats-muted', 'In progress'));
    }
    const label = state === 'success' ? 'Succeeded' : state === 'pending' ? 'In progress' : `Failed (${run.conclusion})`;
    const statusIcon = icon(state, `status-${state}`);
    statusIcon.setAttribute('aria-hidden', 'false');
    statusIcon.setAttribute('role', 'img');
    statusIcon.setAttribute('aria-label', label);
    return listRow(
      statusIcon,
      link(run.url, 'stats-row-title', run.message),
      el('span', 'stats-row-meta', `${run.name} #${run.number} · ${run.branch}`),
      aside
    );
  }));
}

function renderCommits(commits) {
  const list = $('commitsList');
  $('commitsCount').hidden = !commits.length;
  $('commitsCount').textContent = commits.length;
  if (!commits.length) return showEmpty(list, 'No commits yet.');
  list.replaceChildren(...commits.map(commit => {
    const meta = el('span', 'stats-row-meta');
    meta.append(el('strong', '', commit.author), ' committed ', timeElement(commit.date));
    return listRow(
      icon('commit', 'stats-muted'),
      link(commit.url, 'stats-row-title', commit.message),
      meta,
      link(commit.url, 'stats-sha', commit.sha.slice(0, 7))
    );
  }));
}

function renderLanguages(languages) {
  const entries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, bytes]) => sum + bytes, 0);
  const bar = $('langBar');
  const list = $('langList');
  if (!total) {
    bar.replaceChildren();
    return showEmpty(list, 'No code yet.');
  }
  bar.replaceChildren(...entries.map(([name, bytes]) => {
    const segment = el('span', 'lang-segment');
    segment.style.width = `${(bytes / total) * 100}%`;
    segment.style.background = LANGUAGE_COLORS[name] || 'var(--site-muted)';
    segment.title = name;
    return segment;
  }));
  list.replaceChildren(...entries.map(([name, bytes]) => {
    const item = el('li', 'lang-item');
    const dot = el('span', 'lang-dot');
    dot.style.background = LANGUAGE_COLORS[name] || 'var(--site-muted)';
    item.append(dot, el('strong', '', name), el('span', 'stats-muted', `${((bytes / total) * 100).toFixed(1)}%`));
    return item;
  }));
}

async function loadGithub() {
  try {
    const data = await fetchGithub();
    renderRepo(data);
    renderDeploys(data.runs);
    renderCommits(data.commits);
    renderLanguages(data.languages);
  } catch (error) {
    const message = `Couldn't load from GitHub: ${error.message}`;
    $('repoMeta').textContent = message;
    showEmpty($('deploysList'), message);
    showEmpty($('commitsList'), message);
    showEmpty($('langList'), message);
  }
}

// ---------- Site API ----------

function utcDay(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function dayTotal(pages) {
  return Object.values(pages || {}).reduce((sum, count) => sum + count, 0);
}

function renderViews(views) {
  const days = views.days || {};
  const recentDays = Array.from({ length: 30 }, (_, index) => utcDay(Date.now() - index * DAY_MS));
  const pageCounts = {};
  for (const day of recentDays) {
    for (const [page, count] of Object.entries(days[day] || {})) {
      pageCounts[page] = (pageCounts[page] || 0) + count;
    }
  }
  $('tileViews30').textContent = numberFormat.format(dayTotal(pageCounts));
  $('tileViewsTotal').textContent = numberFormat.format(dayTotal(views.totals));
  renderBars(
    $('pagesList'),
    Object.entries(views.totals || {}).sort((a, b) => b[1] - a[1]).map(([page, count]) => [PAGE_NAMES[page] || page, count]),
    'No views yet.'
  );
}

function renderErrors(errors) {
  const box = $('errorsBox');
  box.hidden = !errors;
  if (!errors) return;
  const total = errors.reduce((sum, error) => sum + (error.count || 1), 0);
  $('errorsCount').textContent = numberFormat.format(total);
  $('clearErrors').hidden = !errors.length;
  const list = $('errorsList');
  if (!errors.length) return showEmpty(list, 'No errors reported.');
  list.replaceChildren(...errors.map(error => {
    const where = [PAGE_NAMES[error.page] || error.page, error.source && `${error.source}${error.line ? `:${error.line}` : ''}`]
      .filter(Boolean).join(' · ');
    const aside = el('div', 'stats-row-aside');
    aside.append(timeElement(error.at));
    if (error.count > 1) aside.append(el('span', 'stats-count', `×${numberFormat.format(error.count)}`));
    return listRow(
      icon('alert', 'status-failure'),
      el('span', 'stats-row-title stats-error-message', error.message),
      el('span', 'stats-row-meta', where || 'Unknown source'),
      aside
    );
  }));
}

// Days are Pacific dates ('YYYY-MM-DD'), as Google resets daily limits at midnight Pacific.
function renderGemini(gemini) {
  const box = $('geminiBox');
  box.hidden = !gemini;
  if (!gemini) return;
  const days = gemini.days || {};
  const today = { ok: 0, limited: 0, failed: 0, tokens: 0, ...days[gemini.today] };
  const requests = day => day.ok + day.limited + day.failed;
  const totals = dayList => dayList.reduce((sum, day) => ({
    requests: sum.requests + requests(day),
    tokens: sum.tokens + day.tokens
  }), { requests: 0, tokens: 0 });
  // Every day is kept, so "last 30 days" counts back from today (as dates, which
  // sort correctly as text).
  const monthStart = utcDay(Date.parse(gemini.today) - 29 * DAY_MS);
  const month = totals(Object.entries(days).filter(([date]) => date >= monthStart).map(([, day]) => day));
  const allTime = totals(Object.values(days));
  const firstDay = Object.keys(days).sort()[0];

  const todayText = gemini.dailyLimit
    ? `${numberFormat.format(requests(today))} / ${numberFormat.format(gemini.dailyLimit)} requests`
    : `${numberFormat.format(requests(today))} requests`;
  const breakdown = [
    `${numberFormat.format(today.ok)} answered`,
    today.limited && `${numberFormat.format(today.limited)} over limit`,
    today.failed && `${numberFormat.format(today.failed)} failed`,
    `${numberFormat.format(today.tokens)} tokens`
  ].filter(Boolean).join(' · ');

  const rows = [
    ['Status', gemini.configured ? 'Key set' : 'GEMINI_API_KEY not set on Netlify'],
    ['Today', `${todayText} · ${breakdown}`],
    ['Last 30 days', `${numberFormat.format(month.requests)} requests · ${numberFormat.format(month.tokens)} tokens`],
    ['All time', `${numberFormat.format(allTime.requests)} requests · ${numberFormat.format(allTime.tokens)} tokens`
      + (firstDay ? ` · since ${new Date(`${firstDay}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '')],
    ['Last over limit', gemini.lastLimitedAt ? timeElement(gemini.lastLimitedAt) : 'Never'],
    ['Daily reset', 'Midnight Pacific time']
  ];
  $('geminiUsage').replaceChildren(...rows.map(([label, value]) => {
    const row = el('div', 'connection-row');
    const dd = el('dd');
    dd.append(value);
    row.append(el('dt', '', label), dd);
    return row;
  }));
}

let statsLoadedAsAdmin = null;

async function loadSiteStats() {
  statsLoadedAsAdmin = Boolean(account.user?.isAdmin);
  try {
    const stats = await account.request('GET', null, '?stats=1');
    renderViews(stats.views);
    $('tileAccounts').textContent = numberFormat.format(stats.accounts);
    renderErrors(stats.errors);
    renderGemini(stats.gemini);
  } catch (error) {
    const message = `Stats unavailable: ${error.message}`;
    showEmpty($('pagesList'), message);
    renderErrors(null);
    renderGemini(null);
  }
}

async function loadBacklog() {
  try {
    const { games = [] } = await account.request('GET');
    $('tileGames').textContent = numberFormat.format(games.length);
    const systems = Object.fromEntries(SYSTEM_ORDER.map(system => [system, 0]));
    for (const game of games) systems[systemForGame(game)]++;
    renderBars($('systemsList'), Object.entries(systems).filter(([, count]) => count), 'The backlog is empty.');
  } catch (error) {
    showEmpty($('systemsList'), `Backlog unavailable: ${error.message}`);
  }
}

// The newest games added to anyone's backlog, with whose backlog they're on.
async function loadRecent() {
  try {
    const { recent = [] } = await account.request('GET', null, '?recent=1');
    if (!recent.length) {
      showEmpty($('recentGames'), 'No games yet.');
      return;
    }
    $('recentGames').replaceChildren(...recent.slice(0, 5).map(game => {
      const item = el('li', 'mini-row');
      const title = el('span', 'mini-title', game.title);
      title.append(el('span', 'mini-owner', ` · ${game.owner}`));
      item.append(title, timeElement(game.createdAt));
      return item;
    }));
  } catch (error) {
    showEmpty($('recentGames'), `Recent additions unavailable: ${error.message}`);
  }
}

// Same as systemForGame in js/backlog.js.
function systemForGame(game) {
  const platform = String(game.platform || '').toLocaleLowerCase();
  if (/\b(?:ps\s*5|playstation\s*5)\b/.test(platform)) return 'PS5';
  if (/\b(?:ps\s*3|playstation\s*3)\b/.test(platform)) return 'PS3';
  return 'Misc';
}

async function checkApi() {
  const tile = $('tileApi');
  const dot = el('span', 'status-dot');
  const started = performance.now();
  try {
    await account.request('GET', null, '?session=1');
    dot.dataset.state = 'success';
    tile.replaceChildren(dot, `Online · ${Math.round(performance.now() - started)} ms`);
  } catch {
    dot.dataset.state = 'failure';
    tile.replaceChildren(dot, 'Down');
  }
}

// Two-letter country code to its flag emoji ("GB" -> 🇬🇧).
function flag(countryCode) {
  if (!/^[A-Z]{2}$/.test(countryCode || '')) return '';
  return String.fromCodePoint(...[...countryCode].map(letter => 0x1f1a5 + letter.charCodeAt(0)));
}

async function loadConnection() {
  try {
    const info = await account.request('GET', null, '?whoami=1');
    $('connectionIp').textContent = info.ip || 'Unknown';
    $('copyIp').hidden = !info.ip;
    const place = [info.city, info.region, info.country].filter(Boolean).join(', ');
    $('connectionLocation').textContent = place ? `${flag(info.countryCode)} ${place}`.trim() : 'Unknown';
    $('connectionTimezone').textContent = info.timezone || 'Unknown';
  } catch (error) {
    $('connectionIp').textContent = `Unavailable: ${error.message}`;
  }
}

// ---------- Wiring ----------

$('copyIp').addEventListener('click', async () => {
  const button = $('copyIp');
  try {
    await navigator.clipboard.writeText($('connectionIp').textContent);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});

$('clearErrors').addEventListener('click', async () => {
  const button = $('clearErrors');
  button.disabled = true;
  try {
    await account.request('POST', { action: 'clear-errors' });
    renderErrors([]);
  } catch (error) {
    button.textContent = `Couldn't clear: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

// Errors are admin-only, so reload when someone signs in or out as admin.
document.addEventListener('site-account-change', () => {
  if (account.status === 'ready' && Boolean(account.user?.isAdmin) !== statsLoadedAsAdmin) loadSiteStats();
});

checkApi();
loadConnection();
loadGithub();
loadSiteStats();
loadBacklog();
loadRecent();
