const list = document.getElementById('gameList');
const emptyState = document.getElementById('emptyState');
const dialog = document.getElementById('gameDialog');
const form = document.getElementById('gameForm');
const searchInput = document.getElementById('searchInput');
const saveNote = document.getElementById('saveNote');
const apiUrl = typeof window.BACKLOG_API_URL === 'string'
  ? window.BACKLOG_API_URL.trim().replace(/\/$/, '')
  : '';
let games = [];
let apiReady = false;

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

  document.getElementById('openDialog').disabled = !apiReady;
}

async function apiRequest(method, body) {
  const response = await fetch(apiUrl, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Backlog request failed');
  return result;
}

async function loadGames() {
  if (!apiUrl) {
    saveNote.textContent = 'Set the Netlify function URL to enable shared saves';
    render();
    return;
  }

  saveNote.textContent = 'Connecting to shared backlog…';
  try {
    const result = await apiRequest('GET');
    games = Array.isArray(result.games)
      ? result.games.sort((first, second) => (second.createdAt || 0) - (first.createdAt || 0))
      : [];
    apiReady = true;
    saveNote.textContent = 'Shared with all visitors';
  } catch {
    apiReady = false;
    saveNote.textContent = 'Shared backlog unavailable';
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

  const controls = createElement('div', 'game-entry-controls');
  const remove = createElement('button', 'remove-game', 'Remove');
  remove.type = 'button';
  remove.disabled = !apiReady;
  remove.setAttribute('aria-label', `Remove ${game.title}`);
  remove.addEventListener('click', async () => {
    remove.disabled = true;
    try {
      await apiRequest('DELETE', { id: game.id });
      games = games.filter(entry => entry.id !== game.id);
      saveNote.textContent = 'Shared backlog saved';
      render();
    } catch {
      saveNote.textContent = 'Could not remove game';
      remove.disabled = false;
    }
  });

  controls.append(remove);
  item.append(details, controls);
  return item;
}

function openDialog() {
  form.reset();
  dialog.showModal();
  form.elements.title.focus();
}

document.getElementById('openDialog').addEventListener('click', openDialog);
document.getElementById('closeDialog').addEventListener('click', () => dialog.close());
document.getElementById('cancelDialog').addEventListener('click', () => dialog.close());
searchInput.addEventListener('input', render);

form.addEventListener('submit', event => {
  event.preventDefault();
  if (!apiReady) return;

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
  apiRequest('POST', { game })
    .then(result => {
      games.unshift(result.game);
      saveNote.textContent = 'Shared backlog saved';
      searchInput.value = '';
      render();
      dialog.close();
    })
    .catch(() => {
      saveNote.textContent = 'Could not add game';
    })
    .finally(() => {
      submitButton.disabled = false;
    });
});

render();
loadGames();