(() => {
  const accountControl = document.querySelector('[data-shared-account]');
  if (!accountControl) return;

  const signInLink = accountControl.querySelector('.site-account-link');
  const accountName = accountControl.querySelector('.account-name');
  const signOutButton = accountControl.querySelector('.site-account-signout');
  const apiUrl = typeof window.BACKLOG_API_URL === 'string'
    ? window.BACKLOG_API_URL.trim().replace(/\/$/, '')
    : '';
  const sessionKey = 'besaid-backlog-session';
  const userKey = 'besaid-backlog-user';
  const signInLabel = 'Sign in / Create account';
  let signedInUser = readCachedUser();

  function showSignIn() {
    signedInUser = null;
    localStorage.removeItem(userKey);
    signInLink.hidden = false;
    signInLink.href = 'backlog.html#account';
    signInLink.textContent = signInLabel;
    accountName.hidden = true;
    signOutButton.hidden = true;
  }

  function showSignedIn(user) {
    signedInUser = user;
    localStorage.setItem(userKey, JSON.stringify(user));
    signInLink.hidden = true;
    accountName.hidden = false;
    accountName.textContent = `${user.username}${user.canEdit ? ' | Admin' : ''} |`;
    signOutButton.hidden = false;
  }

  function readCachedUser() {
    try {
      return JSON.parse(localStorage.getItem(userKey) || 'null');
    } catch {
      return null;
    }
  }

  function userFromToken(token) {
    try {
      const payload = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(atob(payload));
      if (typeof decoded.sub !== 'string') return null;
      const username = decoded.sub.toLowerCase();
      return { username: username === 'kiwamari' ? 'Kiwamari' : decoded.sub, canEdit: username === 'kiwamari' };
    } catch {
      return null;
    }
  }

  function signOut() {
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(userKey);
    showSignIn();
  }

  signOutButton.addEventListener('click', signOut);

  window.addEventListener('storage', event => {
    if (event.key === sessionKey || event.key === userKey) loadAccount();
  });

  async function loadAccount() {
    const token = localStorage.getItem(sessionKey);
    if (!token || !apiUrl) {
      showSignIn();
      return;
    }

    showSignedIn(readCachedUser() || userFromToken(token) || { username: 'Account', canEdit: false });

    try {
      const response = await fetch(`${apiUrl}?session=1`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Could not check account');
      const result = await response.json();
      if (localStorage.getItem(sessionKey) !== token) return;
      if (!result.user) {
        localStorage.removeItem(sessionKey);
        showSignIn();
        return;
      }

      showSignedIn(result.user);
    } catch {
      // Keep the locally cached identity visible while Netlify is unavailable.
    }
  }

  loadAccount();
})();