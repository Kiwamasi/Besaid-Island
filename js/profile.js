// Profile page: profile.html?user=<name>. Without a name it shows the signed-in
// person's own profile (and puts their name in the address), or Kiwamari's for
// visitors, the same way as the Backlog page.
//
// Shows whether the account is the admin and premium, how many games are in its
// backlog, how much storage it uses, its Gemini use (premium accounts only, as only
// they use Gemini), and its site colour. The owner can change the
// colour here: it becomes the trim colour on every page while they're signed in, and
// is saved on the server (or in this browser, when testing locally).
const account = window.siteAccount;
const profileTitle = document.getElementById('profileTitle');
const profileNote = document.getElementById('profileNote');
const details = document.getElementById('profileDetails');
const colorInput = document.getElementById('profileColor');
const colorValue = document.getElementById('profileColorValue');
const colorReset = document.getElementById('profileColorReset');
const colorStatus = document.getElementById('profileColorStatus');
const adminPanel = document.getElementById('adminPanel');
const energyTiles = document.getElementById('energyTiles');
const energyNote = document.getElementById('energyNote');
const energyRefresh = document.getElementById('energyRefresh');
const energyChart = document.getElementById('energyChart');
const energyLiveBox = document.getElementById('energyLive');
const discordBotBox = document.getElementById('discordBot');
let requestedOwner = null;
let profile = null;
let loadVersion = 0;

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const numberFormat = new Intl.NumberFormat();
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

// The site's own trim colour from css/site.css, shown when an account hasn't picked one.
function defaultColor() {
  const inline = document.documentElement.style.getPropertyValue('--trim-color');
  document.documentElement.style.removeProperty('--trim-color');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--trim-color').trim();
  if (inline) document.documentElement.style.setProperty('--trim-color', inline);
  return color;
}

function isOwnProfile() {
  return Boolean(profile) && account.isSameAccount(account.user?.username, profile.username);
}

function showColor(color) {
  const shown = color || defaultColor();
  colorInput.value = shown;
  colorValue.textContent = color ? shown : `${shown} (default)`;
}

function showDetails() {
  const { isAdmin, isPremium, games, storage, gemini, color } = profile;
  document.getElementById('profileAdmin').textContent = isAdmin ? 'True' : 'False';
  document.getElementById('profilePremium').textContent = isPremium ? 'True' : 'False';
  document.getElementById('profileGames').textContent = String(games);
  document.getElementById('profileStorage').textContent = `${formatBytes(storage.games + storage.account)}`
    + ` · games ${formatBytes(storage.games)} (${games}) · account ${formatBytes(storage.account)}`;
  document.getElementById('profileGeminiRow').hidden = !gemini;
  if (gemini) {
    const usage = ({ tokens, requests }, when) => `${numberFormat.format(tokens)} tokens ${when}`
      + ` (${numberFormat.format(requests)} ${requests === 1 ? 'request' : 'requests'})`;
    document.getElementById('profileGemini').textContent = `${usage(gemini.today, 'today')} · ${usage(gemini.total, 'in total')}`;
  }
  showColor(color);
  showColorControls();
  details.hidden = false;
}

// Only the owner can change the colour; everyone else just sees it.
function showColorControls() {
  const own = isOwnProfile();
  colorInput.disabled = !own;
  colorReset.hidden = !own || !profile.color;
  colorInput.title = own ? 'Pick your site colour' : `${profile.username}'s site colour`;
}

async function loadProfileFor(name) {
  if (!name || account.isSameAccount(name, requestedOwner)) return;
  const version = ++loadVersion;
  requestedOwner = name;
  profile = null;
  details.hidden = true;
  showAdminPanel();
  profileTitle.textContent = 'Profile';
  profileNote.textContent = 'Loading profile…';
  try {
    const result = await account.request('GET', null, `?profile=${encodeURIComponent(name)}`);
    if (version !== loadVersion) return;
    profile = result.profile;
    profileTitle.textContent = `${profile.username}'s profile`;
    document.title = `${profile.username}'s profile | Besaid Island`;
    profileNote.textContent = '';
    account.showOwnerInAddress(profile.username);
    showDetails();
    showAdminPanel();
  } catch (error) {
    if (version !== loadVersion) return;
    // Let the next sign-in change try again.
    requestedOwner = null;
    profileNote.textContent = error.status === 404
      ? `There's no account called "${name}".`
      : `Profile unavailable: ${error.message}`;
  }
}

async function saveColor(color) {
  if (!isOwnProfile()) return;
  colorStatus.textContent = 'Saving…';
  try {
    profile.color = await account.saveColor(color);
    colorStatus.textContent = 'Saved';
  } catch (error) {
    // Put back the colour that's actually saved.
    account.applyColor();
    colorStatus.textContent = `Could not save: ${error.message}`;
  }
  showColor(profile.color);
  showColorControls();
}

// Dragging around the picker previews the colour across the page; letting go saves it.
colorInput.addEventListener('input', () => {
  if (!isOwnProfile()) return;
  account.applyColor(colorInput.value);
  colorValue.textContent = colorInput.value;
  colorStatus.textContent = '';
});
colorInput.addEventListener('change', () => saveColor(colorInput.value));
colorReset.addEventListener('click', () => saveColor(''));

// ---------- Admin panel (the admin's own profile only) ----------

// Electricity use (kWh only, no costs) from Octopus, through the site API, which keeps
// the API key and meter details to itself and only answers the admin.
const ENERGY_PERIODS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['year', 'This year']
];
const kwhFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let energyShownFor = null;
let energyVersion = 0;
// The last ?energy answer, and today's use so far from the Home Mini (js/energy-live.js),
// which fills the Today tile: the meter's own half-hourly readings arrive a day late.
let energySummary = null;
let liveToday = null;
function showAdminPanel() {
  const show = isOwnProfile() && Boolean(account.user?.isAdmin);
  adminPanel.hidden = !show;
  if (!show) {
    energyShownFor = null;
    window.energyLive.stop();
    window.debugLog.stop();
    return;
  }
  if (energyShownFor !== account.user.username) {
    // First, so the calls below show in the debug log when it's on.
    window.debugLog.start({
      toggle: document.getElementById('debugToggle'),
      column: document.getElementById('debugColumn'),
      request: account.request
    });
    loadEnergy();
    window.discordBot.show(discordBotBox, account.request);
    liveToday = null;
    window.energyLive.start(energyLiveBox, {
      load: () => account.request('GET', null, '?energy-live'),
      loadHistory: date => account.request('GET', null, `?energy-history=${date || 'newest'}`),
      loadArchive: date => account.request('GET', null, `?energy-archive=${date}`),
      setPaused: paused => account.request('POST', { action: 'energy-settings', paused }),
      onUpdate: live => {
        liveToday = live?.today || null;
        if (energySummary) showEnergyTiles();
      }
    });
  }
}

async function loadEnergy(fresh = false) {
  const version = ++energyVersion;
  energyShownFor = account.user.username;
  energyRefresh.disabled = true;
  energyNote.textContent = fresh ? 'Asking Octopus…' : 'Loading…';
  try {
    const energy = await account.request('GET', null, `?energy=${fresh ? 'fresh' : '1'}`);
    if (version !== energyVersion) return;
    // An older Netlify service doesn't know ?energy and answers with a backlog instead.
    if (!energy.periods) throw new Error('The Netlify service is out of date: redeploy it (Netlify → Deploys → Trigger deploy).');
    showEnergy(energy);
  } catch (error) {
    if (version !== energyVersion) return;
    energySummary = null;
    energyTiles.replaceChildren();
    energyChart.replaceChildren();
    energyNote.textContent = error.message;
  } finally {
    if (version === energyVersion) energyRefresh.disabled = false;
  }
}

function showEnergy(summary) {
  const { tariff, latestReading, updatedAt, days, trend } = summary;
  energySummary = summary;
  // Half-hourly chart of past days and the trend line (js/energy-chart.js). A summary
  // saved before the chart existed has no days; Refresh fetches them.
  if (days) window.energyChart.show(energyChart, days, trend);
  else energyChart.replaceChildren(Object.assign(document.createElement('p'), {
    className: 'energy-chart-empty', textContent: 'Press Refresh to load the chart.'
  }));
  showEnergyTiles();
  energyNote.textContent = [
    tariff && `Tariff ${tariff}`,
    latestReading ? `Readings up to ${dateTimeFormat.format(latestReading)}` : 'No readings yet',
    `Checked ${dateTimeFormat.format(updatedAt)}`
  ].filter(Boolean).join(' · ');
}

function showEnergyTiles() {
  const { periods } = energySummary;
  energyTiles.replaceChildren(...ENERGY_PERIODS.map(([key, label]) => {
    // Today from the Home Mini when it's reporting.
    const live = key === 'today' && liveToday;
    const kwhUsed = live ? liveToday.kwh : periods[key].kwh;
    const tile = document.createElement('li');
    tile.className = 'energy-tile';
    const name = document.createElement('span');
    name.className = 'energy-label';
    name.textContent = live ? `${label} (live)` : label;
    const kwh = document.createElement('span');
    kwh.className = 'energy-kwh';
    kwh.textContent = `${kwhFormat.format(kwhUsed)} kWh`;
    tile.append(name, kwh);
    return tile;
  }));
}

// Only the summary: the live view already has the newest reading the scheduled job
// saved, and picks up the next one by itself.
energyRefresh.addEventListener('click', () => loadEnergy(true));

document.addEventListener('site-account-change', () => {
  if (profile) showColorControls();
  showAdminPanel();
  // Signing in or out of a page with no ?user= switches to the right profile.
  loadProfileFor(account.pageOwner());
});
loadProfileFor(account.pageOwner());
