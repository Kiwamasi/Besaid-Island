// Users page: every account, each linking to its profile. Picking someone else starts
// browsing their pages (the nav's Backlog and Profile follow them, see
// js/site-header.js); picking yourself goes back to your own.
//
// The admin also gets a pen next to each account, which opens its settings (premium,
// colour) to change and can fill in missing genres on its backlog with Gemini, and a bin next to each other account, which asks first and then
// deletes the account with its backlog and settings.
const account = window.siteAccount;
const usersList = document.getElementById('usersList');
const usersNote = document.getElementById('usersNote');
const deleteDialog = document.getElementById('deleteDialog');
const deleteText = document.getElementById('deleteText');
const deleteError = document.getElementById('deleteError');
const deleteYes = document.getElementById('deleteYes');
const deleteNo = document.getElementById('deleteNo');
const editDialog = document.getElementById('editDialog');
const editTitle = document.getElementById('editTitle');
const editStatus = document.getElementById('editStatus');
const editFields = document.getElementById('editFields');
const editPremium = document.getElementById('editPremium');
const editColor = document.getElementById('editColor');
const editColorDefault = document.getElementById('editColorDefault');
const editError = document.getElementById('editError');
const editSave = document.getElementById('editSave');
const editGenres = document.getElementById('editGenres');
const editFillGenres = document.getElementById('editFillGenres');
// Time between filling in one missing genre and asking for the next: at most 4 a
// minute, under the free tier's per-minute request limit.
const CATEGORIZE_SPACING_MS = 15000;
const PEN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 1.6a1.4 1.4 0 0 1 2 0l1.1 1.1a1.4 1.4 0 0 1 0 2L5.6 13.5 1.8 14.3l.8-3.8z" fill="currentColor"/></svg>';
const BIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4a.5.5 0 0 1 .5.5v1H13a.75.75 0 0 1 0 1.5h-.6l-.7 9.1A1.5 1.5 0 0 1 10.2 15H5.8a1.5 1.5 0 0 1-1.5-1.4L3.6 4.5H3A.75.75 0 0 1 3 3h2.5V2a.5.5 0 0 1 .5-.5Zm-.9 3 .7 9h4.4l.7-9Zm1.65 1.25a.6.6 0 0 1 .6.6v5.3a.6.6 0 0 1-1.2 0v-5.3a.6.6 0 0 1 .6-.6Zm2.5 0a.6.6 0 0 1 .6.6v5.3a.6.6 0 0 1-1.2 0v-5.3a.6.6 0 0 1 .6-.6Z" fill="currentColor"/></svg>';
let users = [];
// The account the open delete dialog is about.
let deleting = null;
// The profile the open edit dialog shows, as loaded, and a count of dialogs opened,
// so a slow load for an earlier one is ignored.
let editing = null;
let editVersion = 0;
// Games on the open account's backlog with no genre, that Gemini hasn't answered for,
// and whether they're being filled in right now.
let missingGenres = [];
let filling = false;

function showCount() {
  usersNote.textContent = `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`;
}

function render() {
  const me = account.user?.username;
  const admin = Boolean(account.user?.isAdmin);
  usersList.replaceChildren(...users.map(({ username, isAdmin, isPremium }) => {
    const own = account.isSameAccount(username, me);
    const link = document.createElement('a');
    link.className = 'users-link';
    // Your own profile without a name in the link, so the nav stops following anyone.
    link.href = own ? 'profile.html' : `profile.html?user=${encodeURIComponent(username)}`;
    if (own) link.addEventListener('click', () => window.siteNav?.stopViewing());
    const name = document.createElement('span');
    name.className = 'users-name';
    name.textContent = username;
    link.append(name);
    for (const [show, text, variant] of [[isAdmin, 'Admin'], [isPremium, 'Premium', 'premium'], [own, 'You']]) {
      if (!show) continue;
      const tag = document.createElement('span');
      tag.className = variant ? `users-tag users-tag-${variant}` : 'users-tag';
      tag.textContent = text;
      link.append(tag);
    }
    const item = document.createElement('li');
    item.append(link);
    if (admin) {
      const pen = document.createElement('button');
      pen.className = 'users-edit';
      pen.type = 'button';
      pen.innerHTML = PEN_ICON;
      pen.title = `Edit ${username}`;
      pen.setAttribute('aria-label', `Edit ${username}`);
      pen.addEventListener('click', () => openEdit(username));
      item.append(pen);
    }
    if (admin && !isAdmin) {
      const bin = document.createElement('button');
      bin.className = 'users-delete';
      bin.type = 'button';
      bin.innerHTML = BIN_ICON;
      bin.title = `Delete ${username}`;
      bin.setAttribute('aria-label', `Delete ${username}`);
      bin.addEventListener('click', () => askToDelete(username));
      item.append(bin);
    }
    return item;
  }));
}

function askToDelete(username) {
  deleting = username;
  deleteText.textContent = `This permanently deletes ${username}'s account, backlog and settings. It can't be undone.`;
  deleteError.textContent = '';
  deleteYes.disabled = false;
  deleteDialog.showModal();
  deleteNo.focus();
}

async function confirmDelete() {
  const username = deleting;
  deleteYes.disabled = true;
  deleteError.textContent = '';
  try {
    await account.request('POST', { action: 'delete-user', username });
  } catch (error) {
    deleteYes.disabled = false;
    deleteError.textContent = `Could not delete: ${error.message}`;
    return;
  }
  users = users.filter(user => !account.isSameAccount(user.username, username));
  // Stop following them around the site if they were being viewed.
  if (account.isSameAccount(window.siteNav?.viewing, username)) window.siteNav.stopViewing();
  deleteDialog.close();
  showCount();
  render();
}

// ---------- Editing an account (admin only) ----------

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

// The site's own trim colour from css/site.css, ignoring the admin's own colour.
function defaultColor() {
  const inline = document.documentElement.style.getPropertyValue('--trim-color');
  document.documentElement.style.removeProperty('--trim-color');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--trim-color').trim();
  if (inline) document.documentElement.style.setProperty('--trim-color', inline);
  return color;
}

async function openEdit(username) {
  const version = ++editVersion;
  editing = null;
  missingGenres = [];
  filling = false;
  editTitle.textContent = `Edit ${username}`;
  editStatus.textContent = 'Loading…';
  editFields.hidden = true;
  editError.textContent = '';
  editSave.disabled = true;
  editDialog.showModal();
  try {
    const name = encodeURIComponent(username);
    const [{ profile }, { games }] = await Promise.all([
      account.request('GET', null, `?profile=${name}`),
      account.request('GET', null, `?user=${name}`)
    ]);
    if (version !== editVersion || !editDialog.open) return;
    editing = profile;
    missingGenres = games.filter(game => !game.category && !game.noGenre);
  } catch (error) {
    if (version !== editVersion) return;
    editStatus.textContent = `Could not load ${username}: ${error.message}`;
    return;
  }
  document.getElementById('editAdmin').textContent = editing.isAdmin ? 'True' : 'False';
  document.getElementById('editGames').textContent = String(editing.games);
  document.getElementById('editStorage').textContent = `${formatBytes(editing.storage.games + editing.storage.account)}`
    + ` · games ${formatBytes(editing.storage.games)} (${editing.games}) · account ${formatBytes(editing.storage.account)}`;
  editPremium.checked = editing.isPremium;
  // The admin is always premium.
  editPremium.disabled = editing.isAdmin;
  editColor.value = editing.color || defaultColor();
  editColorDefault.checked = !editing.color;
  showMissingGenres();
  editStatus.textContent = '';
  editFields.hidden = false;
  editSave.disabled = false;
}

// ---------- Filling in missing genres (admin only) ----------

// Backlogs never get genres after the fact by themselves; this is the one place they
// do. Only for premium accounts, as only they use Gemini, and it counts as their use.
function showMissingGenres(progress) {
  const count = missingGenres.length;
  editGenres.textContent = progress || (count ? `${count} ${count === 1 ? 'game' : 'games'}` : 'None');
  editFillGenres.hidden = !count || filling;
  editFillGenres.disabled = !editing?.isPremium;
  editFillGenres.title = editing?.isPremium ? '' : 'Needs a premium account (tick Premium User and save first)';
}

// One game at a time, spaced out. Stops if the box is closed, or at the first game
// Gemini doesn't answer for (it can be tried again later).
async function fillGenres() {
  if (!editing?.isPremium || filling) return;
  const version = editVersion;
  const username = editing.username;
  const total = missingGenres.length;
  let done = 0;
  filling = true;
  editError.textContent = '';
  showMissingGenres(`Filling in… 0 of ${total}`);
  while (missingGenres.length && version === editVersion && editDialog.open) {
    let result;
    try {
      result = await account.request('POST', { action: 'categorize', username, id: missingGenres[0].id });
    } catch (error) {
      result = { error };
    }
    if (version !== editVersion) return;
    const unanswered = result.error || (result.game && !result.game.category && !result.game.noGenre);
    if (unanswered) {
      editError.textContent = result.error
        ? `Could not fill in genres: ${result.error.message}`
        : "Gemini didn't answer. Try again later.";
      break;
    }
    missingGenres.shift();
    done++;
    showMissingGenres(`Filling in… ${done} of ${total}`);
    if (missingGenres.length) await new Promise(resolve => setTimeout(resolve, CATEGORIZE_SPACING_MS));
  }
  if (version !== editVersion) return;
  filling = false;
  showMissingGenres(done && !missingGenres.length ? `Filled in ${done} ${done === 1 ? 'game' : 'games'}` : undefined);
}

editFillGenres.addEventListener('click', fillGenres);

// Picking a colour turns "Default" off; turning "Default" on shows the default colour.
editColor.addEventListener('input', () => { editColorDefault.checked = false; });
editColorDefault.addEventListener('change', () => {
  if (editColorDefault.checked) editColor.value = defaultColor();
});

async function saveEdit() {
  if (!editing) return;
  const username = editing.username;
  const color = editColorDefault.checked ? '' : editColor.value;
  const own = account.isSameAccount(username, account.user?.username);
  editSave.disabled = true;
  editError.textContent = '';
  try {
    // Your own colour goes through the account code, so it shows straight away.
    if (own) {
      await account.saveColor(color);
    } else {
      await account.request('POST', { action: 'update-user', username, premium: editPremium.checked, color });
    }
  } catch (error) {
    editSave.disabled = false;
    editError.textContent = `Could not save: ${error.message}`;
    return;
  }
  users = users.map(user => account.isSameAccount(user.username, username)
    ? { ...user, isPremium: user.isAdmin || editPremium.checked }
    : user);
  editDialog.close();
  render();
}

editSave.addEventListener('click', saveEdit);
for (const id of ['editCancel', 'editClose']) {
  document.getElementById(id).addEventListener('click', () => editDialog.close());
}
editDialog.addEventListener('click', event => {
  if (event.target === editDialog) editDialog.close();
});

// ---------- Wiring ----------

deleteYes.addEventListener('click', confirmDelete);
deleteNo.addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('click', event => {
  if (event.target === deleteDialog && !deleteYes.disabled) deleteDialog.close();
});

async function loadUsers() {
  try {
    ({ users } = await account.request('GET', null, '?users=1'));
    showCount();
    render();
  } catch (error) {
    usersNote.textContent = `Users unavailable: ${error.message}`;
  }
}

// Marks "You" on the right account, and shows or hides the bins, after signing in or out.
document.addEventListener('site-account-change', render);
loadUsers();
