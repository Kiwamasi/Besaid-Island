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

document.addEventListener('site-account-change', () => {
  if (profile) showColorControls();
  // Signing in or out of a page with no ?user= switches to the right profile.
  loadProfileFor(account.pageOwner());
});
loadProfileFor(account.pageOwner());
