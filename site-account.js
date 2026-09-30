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
  let isChecking = true;

  function showChecking() {
    isChecking = true;
    signInLink.hidden = true;
    accountName.hidden = false;
    accountName.textContent = 'Checking account…';
    signOutButton.hidden = true;
  }

  function showSignIn() {
    isChecking = false;
    localStorage.removeItem(userKey);
    signInLink.hidden = false;
    signInLink.href = 'backlog.html#account';
    signInLink.textContent = signInLabel;
    accountName.hidden = true;
    signOutButton.hidden = true;
  }

  function showUnavailable() {
    isChecking = false;
    signedInUser = null;
    signInLink.hidden = true;
    accountName.hidden = false;
    accountName.textContent = 'Account status unavailable';
    signOutButton.hidden = true;
  }

  function showSignedIn(user) {
    isChecking = false;
    localStorage.setItem(userKey, JSON.stringify(user));
    signInLink.hidden = true;
    accountName.hidden = false;
    accountName.textContent = `${user.username}${user.canEdit ? ' | Admin' : ''} |`;
    signOutButton.hidden = false;
  }

  function signOut() {
    localStorage.removeItem(sessionKey);
    localStorage.removeItem(userKey);
    showSignIn();
  }

  signOutButton.addEventListener('click', signOut);
  signInLink.addEventListener('click', event => {
    if (isChecking) event.preventDefault();
  });

  window.addEventListener('storage', event => {
    if (event.key === sessionKey || event.key === userKey) loadAccount();
  });

  async function loadAccount() {
    showChecking();
    const token = localStorage.getItem(sessionKey);
    if (!apiUrl) return showUnavailable();

    try {
      const response = await fetch(`${apiUrl}?session=1`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined
      });
      if (!response.ok) throw new Error('Could not check account');
      const result = await response.json();
      if (localStorage.getItem(sessionKey) !== token) return;
      if (!result.user) {
        if (token) localStorage.removeItem(sessionKey);
        showSignIn();
        return;
      }

      showSignedIn(result.user);
    } catch {
      showUnavailable();
    }
  }

  loadAccount();
})();