const list = document.getElementById('gameList');
const emptyState = document.getElementById('emptyState');
const dialog = document.getElementById('gameDialog');
const form = document.getElementById('gameForm');
const searchInput = document.getElementById('searchInput');
const saveNote = document.getElementById('saveNote');
const loginDialog = document.getElementById('loginDialog');
const loginForm = document.getElementById('loginForm');
const loginMessage = document.getElementById('loginMessage');
const accountName = document.getElementById('accountName');
const apiUrl = typeof window.BACKLOG_API_URL === 'string'
  ? window.BACKLOG_API_URL.trim().replace(/\/$/, '')
  : '';
const SESSION_KEY = 'besaid-backlog-session';
let games = [];
let apiReady = false;
let sessionToken = localStorage.getItem(SESSION_KEY);
let currentUser = null;
let authMode = 'login';

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function render() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  const visibleGames = games.filter(game => {
    const textMatches = `${game.title} ${game.platform} ${game.note}`.toLocaleLowerCase().includes(query);
    return textMatches;
  });

  list.replaceChildren(...visibleGames.map(createGameRow));
  emptyState.hidden = visibleGames.length > 0;
  if (games.length > 0 && visibleGames.length === 0) {
    document.getElementById('emptyTitle').textContent = 'No matches';
  } else {
    document.getElementById('emptyTitle').textContent = 'No games yet';
  }
  document.getElementById('openDialog').disabled = !currentUser?.canEdit || !apiReady;
}

async function apiRequest(method, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const response = await fetch(apiUrl, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || 'Backlog request failed');
    error.status = response.status;
    throw error;
  }
  return result;
}

function setSignedIn(user) {
  currentUser = user;
  document.getElementById('loginButton').hidden = Boolean(user);
  document.getElementById('logoutButton').hidden = !user;
  accountName.hidden = !user;
  accountName.textContent = user ? `${user.username} |` : '';
  render();
}

function endSession(message) {
  sessionToken = null;
  localStorage.removeItem(SESSION_KEY);
  setSignedIn(null);
  saveNote.textContent = message;
}

async function loadGames() {
  if (!apiUrl) {
    loginMessage.textContent = 'Shared backlog service is not configured.';
    return;
  }
  saveNote.textContent = 'Connecting to shared backlog…';
  try {
    const result = await apiRequest('GET');
    games = Array.isArray(result.games)
      ? result.games.sort((first, second) => (second.createdAt || 0) - (first.createdAt || 0))
      : [];
    if (sessionToken && !result.user) {
      sessionToken = null;
      localStorage.removeItem(SESSION_KEY);
    }
    setSignedIn(result.user || null);
    apiReady = true;
    saveNote.textContent = currentUser
      ? currentUser.canEdit
        ? 'Signed in as admin · edits are shared'
        : `Signed in as ${currentUser.username} · view only`
      : 'Shared backlog · sign in to edit';
  } catch (error) {
    apiReady = false;
    saveNote.textContent = `Shared backlog unavailable: ${error.message}`;
  }
  render();
}

function createGameRow(game) {
  const item = createElement('li', 'game-entry');
  const details = createElement('div', 'game-entry-details');
  details.append(createElement('h2', '', game.title));

  const meta = createElement('p', 'game-entry-meta');
  if (game.platform) meta.append(createElement('span', 'platform', game.platform));
  if (game.note) meta.append(createElement('span', 'game-note', game.note));
  if (game.platform || game.note) details.append(meta);

  item.append(details);
  if (currentUser?.canEdit) {
    const controls = createElement('div', 'game-entry-controls');
    const remove = createElement('button', 'remove-game', 'Remove');
    remove.type = 'button';
    remove.disabled = !apiReady;
    remove.setAttribute('aria-label', `Remove ${game.title}`);
    remove.addEventListener('click', async () => {
      const previousIndex = games.findIndex(entry => entry.id === game.id);
      games = games.filter(entry => entry.id !== game.id);
      saveNote.textContent = 'Removing…';
      render();
      try {
        await apiRequest('DELETE', { id: game.id });
        saveNote.textContent = 'Shared backlog saved';
      } catch (error) {
        games.splice(Math.max(previousIndex, 0), 0, game);
        if (error.status === 401) {
          endSession('Sign-in expired. The backlog is still viewable; sign in again to edit.');
          return;
        }
        saveNote.textContent = `Could not remove game: ${error.message}`;
        render();
      }
    });
    controls.append(remove);
    item.append(controls);
  }
  return item;
}

function openDialog() {
  form.reset();
  dialog.showModal();
  form.elements.title.focus();
}

document.getElementById('openDialog').addEventListener('click', openDialog);
document.getElementById('loginButton').addEventListener('click', () => {
  setAuthMode('login');
  loginDialog.showModal();
  loginForm.elements.username.focus();
});
document.getElementById('loginClose').addEventListener('click', () => loginDialog.close());
document.getElementById('closeDialog').addEventListener('click', () => dialog.close());
document.getElementById('cancelDialog').addEventListener('click', () => dialog.close());
document.getElementById('logoutButton').addEventListener('click', () => {
  endSession('Signed out. The shared backlog remains viewable.');
});
searchInput.addEventListener('input', render);

function setAuthMode(mode) {
  authMode = mode;
  document.querySelector('.auth-modes').hidden = false;
  loginForm.querySelectorAll('.form-field').forEach(field => { field.hidden = false; });
  document.querySelectorAll('[data-auth-mode]').forEach(button => {
    const selected = button.dataset.authMode === mode;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.getElementById('loginTitle').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  const submitButton = document.getElementById('loginSubmit');
  submitButton.type = 'submit';
  submitButton.textContent = mode === 'login' ? 'Sign in' : 'Create account';
  loginForm.elements.password.minLength = 0;
  loginForm.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  loginMessage.textContent = mode === 'register'
    ? 'Accounts can view the shared list. Only admins can edit it.'
    : '';
}

document.querySelectorAll('[data-auth-mode]').forEach(button => {
  button.addEventListener('click', () => setAuthMode(button.dataset.authMode));
});

document.getElementById('loginSubmit').addEventListener('click', event => {
  if (event.currentTarget.type === 'button') loginDialog.close();
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submitButton = document.getElementById('loginSubmit');
  const values = new FormData(loginForm);
  submitButton.disabled = true;
  loginMessage.textContent = 'Signing in…';

  try {
    const result = await apiRequest('POST', {
      action: authMode,
      username: String(values.get('username') || ''),
      password: String(values.get('password') || '')
    });
    const createdAccount = authMode === 'register';
    sessionToken = result.token;
    localStorage.setItem(SESSION_KEY, sessionToken);
    loginForm.reset();
    setSignedIn(result.user);
    await loadGames();
    if (createdAccount) {
      document.querySelector('.auth-modes').hidden = true;
      loginForm.querySelectorAll('.form-field').forEach(field => { field.hidden = true; });
      loginMessage.textContent = 'Account created successfully. You are signed in with view-only access; only admins can edit the shared backlog.';
      submitButton.type = 'button';
      submitButton.textContent = 'Done';
    } else {
      loginDialog.close();
    }
  } catch (error) {
    loginForm.elements.password.value = '';
    loginMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!currentUser?.canEdit) {
    saveNote.textContent = 'Sign in to edit the shared backlog.';
    return;
  }
  if (!apiReady) {
    saveNote.textContent = 'Backlog is still connecting; close this and retry in a moment.';
    loadGames();
    return;
  }

  const values = new FormData(form);
  const title = String(values.get('title') || '').trim();
  if (!title) return;

  const game = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title,
    platform: String(values.get('platform') || '').trim(),
    note: String(values.get('note') || '').trim(),
    createdAt: Date.now()
  };
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  games.unshift(game);
  searchInput.value = '';
  saveNote.textContent = 'Saving…';
  render();
  dialog.close();
  apiRequest('POST', { game })
    .then(result => {
      games = games.map(entry => entry.id === game.id ? result.game : entry);
      saveNote.textContent = 'Shared backlog saved';
    })
    .catch(error => {
      games = games.filter(entry => entry.id !== game.id);
      if (error.status === 401) {
        endSession('Sign-in expired. The backlog is still viewable; sign in again to edit.');
        return;
      }
      saveNote.textContent = `Could not add game: ${error.message}`;
      render();
    })
    .finally(() => {
      submitButton.disabled = false;
    });
});

render();
setSignedIn(null);
loadGames();
if (window.location.hash === '#account') {
  setAuthMode('login');
  loginDialog.showModal();
  loginForm.elements.username.focus();
}