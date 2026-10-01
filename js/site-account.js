// Site-wide account handling: the header's signed-in state, the sign-in /
// create-account dialog, and sign-out. Works the same on every page.
//
// Load after js/site-header.js, js/site-config.js and js/local-mock-api.js.
// Pages that care who is signed in use window.siteAccount:
//   siteAccount.status   'checking' | 'ready' | 'unavailable'
//   siteAccount.user     { username, canEdit } or null
//   siteAccount.request(method, body)   call the API with the session token
//   siteAccount.signOut()
// and listen for the 'site-account-change' event on document.
(() => {
  const SESSION_KEY = 'besaid-backlog-session';
  const apiUrl = typeof window.SITE_API_URL === 'string'
    ? window.SITE_API_URL.trim().replace(/\/$/, '')
    : '';

  const accountControl = document.querySelector('.site-header .site-account');
  if (!accountControl) return;
  const signInButton = accountControl.querySelector('.site-account-signin');
  const accountName = accountControl.querySelector('.account-name');
  const signOutButton = accountControl.querySelector('.site-account-signout');

  let token = localStorage.getItem(SESSION_KEY);
  let status = 'checking';
  let user = null;
  // Bumped whenever the session changes, so a slow session check can't overwrite it.
  let sessionVersion = 0;

  // ---------- API ----------

  async function request(method, body, query = '') {
    if (!apiUrl) throw new Error('Shared backlog service is not configured');
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(`${apiUrl}${query}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error(`The server returned an unreadable response (HTTP ${response.status})`);
    }
    if (!response.ok) {
      const error = new Error(result.error || 'Request failed');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  // ---------- Session state ----------

  function setToken(nextToken) {
    token = nextToken;
    if (token) localStorage.setItem(SESSION_KEY, token);
    else localStorage.removeItem(SESSION_KEY);
  }

  function setState(nextStatus, nextUser) {
    status = nextStatus;
    user = nextUser;
    renderHeader();
    document.dispatchEvent(new CustomEvent('site-account-change'));
  }

  function renderHeader() {
    signInButton.hidden = status !== 'ready' || Boolean(user);
    signOutButton.hidden = !user;
    accountName.hidden = status === 'ready' && !user;
    if (status === 'checking') accountName.textContent = 'Checking account…';
    else if (status === 'unavailable') accountName.textContent = 'Account status unavailable';
    else accountName.textContent = user ? `${user.username}${user.canEdit ? ' | Admin' : ''} |` : '';
  }

  async function checkSession() {
    const version = ++sessionVersion;
    if (!apiUrl) {
      setState('unavailable', null);
      return;
    }
    setState('checking', null);
    try {
      const result = await request('GET', null, '?session=1');
      if (version !== sessionVersion) return;
      if (!result.user && token) setToken(null);
      setState('ready', result.user || null);
    } catch {
      if (version === sessionVersion) setState('unavailable', null);
    }
  }

  function signOut() {
    sessionVersion++;
    setToken(null);
    setState('ready', null);
  }

  // ---------- Sign-in / create-account dialog ----------

  const dialog = document.createElement('dialog');
  dialog.className = 'site-dialog login-dialog';
  dialog.setAttribute('aria-labelledby', 'loginTitle');
  dialog.innerHTML = `
    <form novalidate>
      <div class="dialog-heading">
        <h2 id="loginTitle">Sign in</h2>
        <button class="dialog-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="auth-modes" role="group" aria-label="Account action">
        <button class="auth-mode is-active" type="button" data-auth-mode="login" aria-pressed="true">Sign in</button>
        <button class="auth-mode" type="button" data-auth-mode="register" aria-pressed="false">Create account</button>
      </div>
      <label class="form-field">
        <span>Username</span>
        <input name="username" type="text" required maxlength="128" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">
      </label>
      <label class="form-field">
        <span>Password</span>
        <input name="password" type="password" required autocomplete="current-password" autocapitalize="none" autocorrect="off" spellcheck="false">
      </label>
      <button class="button-primary login-submit" type="submit">Sign in</button>
      <p class="login-message" role="status"></p>
    </form>`;
  document.body.append(dialog);

  const form = dialog.querySelector('form');
  const title = dialog.querySelector('#loginTitle');
  const modes = dialog.querySelector('.auth-modes');
  const fields = dialog.querySelectorAll('.form-field');
  const submitButton = dialog.querySelector('.login-submit');
  const message = dialog.querySelector('.login-message');
  let authMode = 'login';

  function showMessage(text, state = '') {
    message.textContent = text;
    message.dataset.state = state;
  }

  function setAuthMode(mode) {
    authMode = mode;
    modes.hidden = false;
    fields.forEach(field => { field.hidden = false; });
    dialog.querySelectorAll('[data-auth-mode]').forEach(button => {
      const selected = button.dataset.authMode === mode;
      button.classList.toggle('is-active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    title.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    submitButton.type = 'submit';
    submitButton.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    form.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    showMessage(mode === 'register' ? 'Accounts can view the shared list. Only admins can edit it.' : '');
  }

  function openDialog() {
    setAuthMode('login');
    dialog.showModal();
    form.elements.username.focus();
  }

  dialog.querySelectorAll('[data-auth-mode]').forEach(button => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
  });
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  // After an account is created the submit button becomes "Done".
  submitButton.addEventListener('click', () => {
    if (submitButton.type === 'button') dialog.close();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(form);
    const username = String(values.get('username') || '').trim();
    const password = String(values.get('password') || '');
    if (!username || username.length > 128) {
      showMessage('Username cannot be blank and must be 128 characters or fewer.', 'error');
      form.elements.username.focus();
      return;
    }
    if (!password || password.length > 128) {
      showMessage('Enter a password of 1–128 characters.', 'error');
      form.elements.password.focus();
      return;
    }

    const registering = authMode === 'register';
    submitButton.disabled = true;
    showMessage(registering ? 'Creating account…' : 'Signing in…', 'pending');

    try {
      const result = await request('POST', { action: authMode, username, password });
      sessionVersion++;
      setToken(result.token);
      form.reset();
      setState('ready', result.user);
      if (registering) {
        modes.hidden = true;
        fields.forEach(field => { field.hidden = true; });
        showMessage('Account created successfully. You are signed in with view-only access; only admins can edit the shared backlog.', 'success');
        submitButton.type = 'button';
        submitButton.textContent = 'Done';
      } else {
        dialog.close();
      }
    } catch (error) {
      form.elements.password.value = '';
      const httpStatus = error.status ? ` (HTTP ${error.status})` : '';
      showMessage(`${registering ? 'Account creation' : 'Sign-in'} failed${httpStatus}: ${error.message}`, 'error');
    } finally {
      submitButton.disabled = false;
    }
  });

  // ---------- Wiring ----------

  signInButton.addEventListener('click', openDialog);
  signOutButton.addEventListener('click', signOut);

  // Keep tabs in sync when the session changes in another tab.
  window.addEventListener('storage', event => {
    if (event.key !== SESSION_KEY) return;
    token = event.newValue;
    checkSession();
  });

  window.siteAccount = {
    get status() { return status; },
    get user() { return user; },
    request,
    signOut
  };

  checkSession();
  // Old links pointed at backlog.html#account to open the sign-in dialog.
  if (window.location.hash === '#account') openDialog();
})();
