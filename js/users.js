// Users page: every account, each linking to its profile. Picking someone else starts
// browsing their pages (the nav's Backlog and Profile follow them, see
// js/site-header.js); picking yourself goes back to your own.
//
// The admin also gets a bin next to each other account, which asks first and then
// deletes the account with its backlog and settings.
const account = window.siteAccount;
const usersList = document.getElementById('usersList');
const usersNote = document.getElementById('usersNote');
const deleteDialog = document.getElementById('deleteDialog');
const deleteText = document.getElementById('deleteText');
const deleteError = document.getElementById('deleteError');
const deleteYes = document.getElementById('deleteYes');
const deleteNo = document.getElementById('deleteNo');
const BIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4a.5.5 0 0 1 .5.5v1H13a.75.75 0 0 1 0 1.5h-.6l-.7 9.1A1.5 1.5 0 0 1 10.2 15H5.8a1.5 1.5 0 0 1-1.5-1.4L3.6 4.5H3A.75.75 0 0 1 3 3h2.5V2a.5.5 0 0 1 .5-.5Zm-.9 3 .7 9h4.4l.7-9Zm1.65 1.25a.6.6 0 0 1 .6.6v5.3a.6.6 0 0 1-1.2 0v-5.3a.6.6 0 0 1 .6-.6Zm2.5 0a.6.6 0 0 1 .6.6v5.3a.6.6 0 0 1-1.2 0v-5.3a.6.6 0 0 1 .6-.6Z" fill="currentColor"/></svg>';
let users = [];
// The account the open dialog is about.
let deleting = null;

function showCount() {
  usersNote.textContent = `${users.length} ${users.length === 1 ? 'account' : 'accounts'}`;
}

function render() {
  const me = account.user?.username;
  const admin = Boolean(account.user?.isAdmin);
  usersList.replaceChildren(...users.map(({ username, isAdmin }) => {
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
    for (const [show, text] of [[isAdmin, 'Admin'], [own, 'You']]) {
      if (!show) continue;
      const tag = document.createElement('span');
      tag.className = 'users-tag';
      tag.textContent = text;
      link.append(tag);
    }
    const item = document.createElement('li');
    item.append(link);
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
