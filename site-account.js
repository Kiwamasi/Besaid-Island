(() => {
  const accountLink = document.querySelector('[data-shared-account]');
  const apiUrl = typeof window.BACKLOG_API_URL === 'string'
    ? window.BACKLOG_API_URL.trim().replace(/\/$/, '')
    : '';
  const sessionKey = 'besaid-backlog-session';
  const signInLabel = 'Sign in / Create account';
  let signedInUser = null;

  if (!accountLink) return;

  function showSignIn() {
    signedInUser = null;
    accountLink.href = 'backlog.html#account';
    accountLink.textContent = signInLabel;
    accountLink.setAttribute('aria-label', signInLabel);
  }

  accountLink.addEventListener('click', event => {
    if (!signedInUser) return;
    event.preventDefault();
    localStorage.removeItem(sessionKey);
    showSignIn();
  });

  window.addEventListener('storage', event => {
    if (event.key === sessionKey) loadAccount();
  });

  async function loadAccount() {
    const token = localStorage.getItem(sessionKey);
    if (!token || !apiUrl) {
      showSignIn();
      return;
    }

    try {
      const response = await fetch(apiUrl, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Could not check account');
      const result = await response.json();
      if (!result.user) {
        localStorage.removeItem(sessionKey);
        showSignIn();
        return;
      }

      signedInUser = result.user;
      accountLink.href = 'backlog.html';
      accountLink.textContent = `${result.user.username}${result.user.canEdit ? ' | Admin' : ''} | Sign Out`;
      accountLink.setAttribute('aria-label', `${accountLink.textContent}, sign out`);
    } catch {
      showSignIn();
    }
  }

  loadAccount();
})();