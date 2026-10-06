// Profile page: profile.html?user=<name>. Without a name it shows the signed-in
// person's own profile (and puts their name in the address), or Kiwamari's for
// visitors, the same way as the Backlog page. Just the name for now.
const account = window.siteAccount;
const profileTitle = document.getElementById('profileTitle');
const profileNote = document.getElementById('profileNote');
let requestedOwner = null;
let loadVersion = 0;

async function loadProfileFor(name) {
  if (!name || account.isSameAccount(name, requestedOwner)) return;
  const version = ++loadVersion;
  requestedOwner = name;
  profileTitle.textContent = 'Profile';
  profileNote.textContent = 'Loading profile…';
  try {
    const { profile } = await account.request('GET', null, `?profile=${encodeURIComponent(name)}`);
    if (version !== loadVersion) return;
    profileTitle.textContent = `${profile.username}'s profile`;
    document.title = `${profile.username}'s profile | Besaid Island`;
    profileNote.textContent = '';
    account.showOwnerInAddress(profile.username);
  } catch (error) {
    if (version !== loadVersion) return;
    // Let the next sign-in change try again.
    requestedOwner = null;
    profileNote.textContent = error.status === 404
      ? `There's no account called "${name}".`
      : `Profile unavailable: ${error.message}`;
  }
}

// Signing in or out of a page with no ?user= switches to the right profile.
document.addEventListener('site-account-change', () => loadProfileFor(account.pageOwner()));
loadProfileFor(account.pageOwner());
