// Backlog page: loads, filters, adds, edits and removes games. Who is signed in
// comes from the shared js/site-account.js.
//
// Every account has its own backlog, at backlog.html?user=<name>. Without a name the
// page shows the signed-in person's own backlog (and puts their name in the address),
// or Kiwamari's for visitors. Only the owner can change a backlog.
//
// Each game's genre ("RPG", "Shooter"…) is picked by the server when it's first added
// (Gemini, for premium accounts only; anyone can type one in brackets), and shown after
// its note in brackets: "Replaying on hard (RPG)", or just "(RPG)". Games without one
// are never filled in from here; the admin can do that from the Users page.
// The genre buttons next to the search box show only that genre's games; the rest
// pop out, and pop back in when the filter is cleared.
//
// The owner edits inline with a "slot": a game-shaped box with a name and a note field.
// - The green "+" at the end of each section opens an empty slot to add a game.
// - The pen on a game turns it into a slot filled in with its name and note.
// Pressing Enter, or moving focus out of the slot, saves it. Escape cancels, and
// an empty name cancels too (for an edit, the game is left as it was).
const account = window.siteAccount;
const list = document.getElementById('gameList');
const emptyState = document.getElementById('emptyState');
const emptyTitle = document.getElementById('emptyTitle');
const searchInput = document.getElementById('searchInput');
const genreFilters = document.getElementById('genreFilters');
const saveNote = document.getElementById('saveNote');
const pageTitle = document.getElementById('page-title');
const SYSTEM_ORDER = ['PS5', 'PS3', 'Misc'];
// Games are listed alphabetically within each section. Numeric so "Final Fantasy 9"
// comes before "Final Fantasy 10"; case-insensitive.
const titleOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Saved names always start with a capital letter ("elden ring" -> "Elden ring");
// the rest is kept exactly as typed.
function cleanTitle(title) {
  const trimmed = title.trim();
  return trimmed.charAt(0).toLocaleUpperCase() + trimmed.slice(1);
}

// Brackets at the very end of a note set the game's genre by hand, without asking
// Gemini: "Replaying on hard (RPG)" -> note "Replaying on hard", genre "RPG".
const CATEGORY_IN_NOTE = /^(.*?)\s*\(([^()]{1,30})\)$/;
function splitNote(text) {
  const trimmed = text.trim();
  const match = trimmed.match(CATEGORY_IN_NOTE);
  return match ? { note: match[1], category: matchingCategory(match[2].trim()) } : { note: trimmed, category: '' };
}

// A typed genre takes the spelling of one already in the backlog ("rpg" -> "RPG"),
// so it lands under the same genre button.
function matchingCategory(category) {
  return games.find(game => game.category && titleOrder.compare(game.category, category) === 0)?.category || category;
}

// The note as it's shown, with the genre after it: "Replaying on hard (RPG)".
function noteWithCategory(game) {
  return [game.note, game.category && `(${game.category})`].filter(Boolean).join(' ');
}
const PEN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 1.6a1.4 1.4 0 0 1 2 0l1.1 1.1a1.4 1.4 0 0 1 0 2L5.6 13.5 1.8 14.3l.8-3.8z" fill="currentColor"/></svg>';
let games = [];
let gamesLoaded = false;
let apiReady = false;
// The name asked for (from the link or the sign-in), and the backlog's owner as the
// server shows it ("Kiwamari"), once loaded. null if there's no such account.
let requestedOwner = null;
let owner = null;
// Bumped for each load, so a slow answer for someone else's backlog is ignored.
let loadVersion = 0;
// The open slot, if any: { mode: 'add' | 'edit', system, gameId, title, note, focus, closing }.
let draft = null;
// The genre button that's on, or '' for all games.
let genreFilter = '';

const POP_IN = [
  { opacity: 0, transform: 'scale(0.4)' },
  { opacity: 1, transform: 'scale(1.05)', offset: 0.7 },
  { opacity: 1, transform: 'scale(1)' }
];
const POP_OUT = [
  { opacity: 1, transform: 'scale(1)' },
  { opacity: 1, transform: 'scale(1.05)', offset: 0.3 },
  { opacity: 0, transform: 'scale(0.4)' }
];
// A gentler pop for swapping a game and its edit slot in place.
const POP_SWAP = [
  { opacity: 0.3, transform: 'scale(0.9)' },
  { opacity: 1, transform: 'scale(1.04)', offset: 0.6 },
  { opacity: 1, transform: 'scale(1)' }
];

// Only the owner can change a backlog.
function canEdit() {
  return account.isSameAccount(account.user?.username, owner);
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function findSlot(id) {
  return [...list.querySelectorAll('[data-id]')].find(slot => slot.dataset.id === id);
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Runs a Web Animation, resolving when it ends. The timeout is a fallback for when
// the browser doesn't run animations (e.g. a hidden tab), so nothing ever stalls.
function playAnimation(element, keyframes, options) {
  if (!element || reducedMotion.matches) return Promise.resolve();
  const animation = element.animate(keyframes, options);
  return Promise.race([
    animation.finished.catch(() => {}),
    new Promise(resolve => setTimeout(resolve, options.duration + 150))
  ]);
}

async function pop(element, keyframes, options) {
  if (!element) return;
  element.classList.add('is-popping');
  await playAnimation(element, keyframes, options);
  element.classList.remove('is-popping');
}

// Re-renders without the fade-in on every game, and slides slots that moved
// (e.g. into the gap left by a removed game) smoothly to their new spot.
// `startPositions` lets a new slot start where another one was.
function renderAndSlide(startPositions = {}) {
  const previousPositions = new Map(
    [...list.querySelectorAll('[data-id]')].map(slot => [slot.dataset.id, slot.getBoundingClientRect()])
  );
  for (const [id, rect] of Object.entries(startPositions)) previousPositions.set(id, rect);
  render({ fadeIn: false });
  if (reducedMotion.matches) return;
  for (const slot of list.querySelectorAll('[data-id]')) {
    const previous = previousPositions.get(slot.dataset.id);
    if (!previous) continue;
    const current = slot.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (dx || dy) {
      slot.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 220, easing: 'ease-out' }
      );
    }
  }
}

function matchesGenre(game, genre = genreFilter) {
  return !genre || game.category === genre;
}

function render({ fadeIn = true } = {}) {
  list.classList.toggle('no-fade-in', !fadeIn);
  renderGenreFilters();
  const query = searchInput.value.trim().toLocaleLowerCase();
  const visibleGames = games.filter(game => matchesGenre(game)
    && `${game.title} ${game.platform} ${game.category || ''} ${game.note}`.toLocaleLowerCase().includes(query)
  );
  // The owner always sees every section (even empty ones) so they can add to it.
  const editing = canEdit() && apiReady;
  const showSections = visibleGames.length > 0 || (editing && !query && !genreFilter);

  const systemGroups = SYSTEM_ORDER.map((system, order) => ({
    system,
    order,
    games: visibleGames
      .filter(game => systemForGame(game) === system)
      .sort((first, second) => titleOrder.compare(first.title, second.title))
  })).sort((first, second) => second.games.length - first.games.length || first.order - second.order);

  list.replaceChildren(...(showSections ? systemGroups.map(({ system, games: systemGames }) => {
    const section = createElement('section', 'system-section');
    const heading = createElement('header', 'system-heading');
    heading.append(
      createElement('h2', '', system),
      createElement('span', 'system-count', String(systemGames.length))
    );
    const systemList = createElement('ul', 'game-list');
    systemList.append(...systemGames.map(game =>
      draft?.mode === 'edit' && draft.gameId === game.id ? createDraftSlot() : createGameRow(game)
    ));
    if (editing) {
      systemList.append(draft?.mode === 'add' && draft.system === system ? createDraftSlot() : createAddSlot(system));
    }
    section.append(heading, systemList);
    return section;
  }) : []));
  emptyState.hidden = !gamesLoaded || showSections;
  emptyTitle.textContent = games.length > 0 && visibleGames.length === 0 ? 'No matches' : 'No games yet';

  // Keep typing where you were if the list is redrawn mid-draft.
  if (draft?.focus) list.querySelector(`.game-draft [name="${draft.focus}"]`)?.focus();
}

// ---------- Genre filter ----------

// One button per genre in the backlog, with how many games have it, plus "All".
function renderGenreFilters() {
  const counts = new Map();
  for (const game of games) {
    if (game.category) counts.set(game.category, (counts.get(game.category) || 0) + 1);
  }
  // The last game of the chosen genre was removed or changed: show everything again.
  if (genreFilter && !counts.has(genreFilter)) genreFilter = '';
  const focused = document.activeElement?.closest?.('.genre-chip')?.dataset.genre;
  const genres = [...counts.keys()].sort((first, second) => titleOrder.compare(first, second));

  genreFilters.hidden = !genres.length;
  genreFilters.replaceChildren(...['', ...genres].map(genre => {
    const button = createElement('button', 'genre-chip', genre || 'All');
    button.type = 'button';
    button.dataset.genre = genre;
    button.setAttribute('aria-pressed', String(genre === genreFilter));
    if (genre) button.append(createElement('span', 'genre-chip-count', String(counts.get(genre))));
    button.addEventListener('click', () => setGenreFilter(genre === genreFilter ? '' : genre));
    return button;
  }));
  if (focused !== undefined) genreFilters.querySelector(`[data-genre="${CSS.escape(focused)}"]`)?.focus();
}

// Games outside the new genre pop out, the rest slide together, then games
// that are now included pop in, like adding and removing a game.
async function setGenreFilter(genre) {
  if (genre === genreFilter) return;
  if (draft && !draft.closing && !finishDraft()) return;
  genreFilter = genre;
  renderGenreFilters();
  const leaving = games.filter(game => !matchesGenre(game, genre)).map(game => findSlot(game.id)).filter(Boolean);
  await Promise.all(leaving.map(slot => pop(slot, POP_OUT, { duration: 240, easing: 'ease-in', fill: 'forwards' })));
  // Another genre was picked while these popped out; that one takes over.
  if (genreFilter !== genre) return;
  const shown = new Set([...list.querySelectorAll('[data-id]')].map(slot => slot.dataset.id));
  renderAndSlide();
  for (const slot of list.querySelectorAll('.game-entry[data-id]')) {
    if (!shown.has(slot.dataset.id)) pop(slot, POP_IN, { duration: 240, easing: 'ease-out' });
  }
}

function systemForGame(game) {
  const platform = String(game.platform || '').toLocaleLowerCase();
  if (/\b(?:ps\s*5|playstation\s*5)\b/.test(platform)) return 'PS5';
  if (/\b(?:ps\s*3|playstation\s*3)\b/.test(platform)) return 'PS3';
  return 'Misc';
}

function showAccountNote() {
  if (!apiReady || !owner) return;
  const { status, user } = account;
  if (canEdit()) saveNote.textContent = 'Your backlog · changes are saved for everyone to see';
  else if (status === 'checking') saveNote.textContent = `${owner}'s backlog · checking account…`;
  else if (status === 'unavailable') saveNote.textContent = `${owner}'s backlog · account status unavailable`;
  else if (!user) saveNote.textContent = `${owner}'s backlog · sign in or create an account to make your own`;
  else saveNote.textContent = `${owner}'s backlog · view only`;
}

// The heading names the backlog's owner: "Kiwamari's Backlog".
function showPageTitle() {
  pageTitle.textContent = owner ? `${owner}'s Backlog` : 'Backlog';
}

function signInExpired() {
  account.signOut();
  saveNote.textContent = 'Sign-in expired. Sign in again to edit your backlog.';
}

// Loads the backlog the page should show, if that's changed: on opening the page,
// and when someone signs in or out of a page with no ?user= in its link.
async function loadGamesFor(name) {
  if (!name || account.isSameAccount(name, requestedOwner)) return;
  const version = ++loadVersion;
  requestedOwner = name;
  owner = null;
  games = [];
  gamesLoaded = false;
  apiReady = false;
  draft = null;
  genreFilter = '';
  showPageTitle();
  render();
  saveNote.textContent = 'Loading backlog…';
  try {
    const result = await account.request('GET', null, `?user=${encodeURIComponent(name)}`);
    if (version !== loadVersion) return;
    owner = result.owner.username;
    games = Array.isArray(result.games) ? result.games : [];
    gamesLoaded = true;
    apiReady = true;
    account.showOwnerInAddress(owner);
    showAccountNote();
  } catch (error) {
    if (version !== loadVersion) return;
    // Let the next sign-in change try again.
    requestedOwner = null;
    saveNote.textContent = error.status === 404
      ? `There's no account called "${name}".`
      : `Backlog unavailable: ${error.message}`;
  }
  showPageTitle();
  render();
}

// Puts a genre from the server into the list without redrawing everything,
// so an open slot keeps its cursor.
function showCategory({ id, category, noGenre }) {
  const game = games.find(entry => entry.id === id);
  if (!game) return;
  const updated = { ...game, category, noGenre };
  games = games.map(entry => entry === game ? updated : entry);
  renderGenreFilters();
  const slot = findSlot(id);
  if (!slot || slot.classList.contains('game-draft')) return;
  const focused = [...slot.querySelectorAll('button')].find(button => button === document.activeElement);
  const row = createGameRow(updated);
  slot.replaceWith(row);
  if (focused) row.querySelector(`.${focused.classList[0]}`)?.focus();
}

// ---------- Games ----------

function createGameRow(game) {
  const item = createElement('li', 'game-entry');
  item.dataset.id = game.id;
  const details = createElement('div', 'game-entry-details');
  // Title and note can be cut off with "…", so hovering shows them in full.
  const noteLine = noteWithCategory(game);
  details.title = noteLine ? `${game.title}\n${noteLine}` : game.title;
  details.append(createElement('h2', '', game.title));

  if (game.category || game.note) {
    const meta = createElement('p', 'game-entry-meta');
    if (game.note) meta.append(createElement('span', 'game-note', game.note));
    if (game.category) meta.append(createElement('span', 'game-category', `(${game.category})`));
    details.append(meta);
  }

  item.append(details);
  if (canEdit()) {
    const controls = createElement('div', 'game-entry-controls');

    const edit = createElement('button', 'edit-game');
    edit.innerHTML = PEN_ICON;
    edit.title = 'Edit';
    edit.type = 'button';
    edit.disabled = !apiReady;
    edit.setAttribute('aria-label', `Edit ${game.title}`);
    edit.addEventListener('click', () => openEdit(game.id));

    const remove = createElement('button', 'remove-game', '−');
    remove.title = 'Remove';
    remove.type = 'button';
    remove.disabled = !apiReady;
    remove.setAttribute('aria-label', `Remove ${game.title}`);
    remove.addEventListener('click', () => removeGame(game.id));

    controls.append(edit, remove);
    item.append(controls);
  }
  return item;
}

async function removeGame(gameId) {
  const previousIndex = games.findIndex(entry => entry.id === gameId);
  if (previousIndex === -1) return;
  const [game] = games.splice(previousIndex, 1);
  const item = findSlot(gameId);
  item?.querySelectorAll('button').forEach(button => { button.disabled = true; });
  saveNote.textContent = 'Removing…';
  const saving = account.request('DELETE', { id: gameId });
  saving.catch(() => {}); // handled below, after the animation
  // Pop: swell slightly, then shrink and fade away. Then close the gap.
  await pop(item, POP_OUT, { duration: 240, easing: 'ease-in', fill: 'forwards' });
  renderAndSlide();
  try {
    await saving;
    saveNote.textContent = 'Backlog saved';
  } catch (error) {
    games.splice(Math.max(previousIndex, 0), 0, game);
    if (error.status === 401) {
      signInExpired();
      return;
    }
    saveNote.textContent = `Could not remove game: ${error.message}`;
    render();
  }
}

// ---------- Add / edit slots ----------

function createAddSlot(system) {
  const item = createElement('li', 'game-add');
  item.dataset.id = `add:${system}`;
  const button = createElement('button', 'game-add-button', '+');
  button.type = 'button';
  button.title = 'Add game';
  button.setAttribute('aria-label', `Add a ${system} game`);
  button.addEventListener('click', () => openDraft(system));
  // Type to start: with the "+" focused, typing a character opens the slot with
  // that character already in the name, so "Borderlands" can just be typed.
  // Space and Enter keep their normal "press the button" behaviour.
  button.addEventListener('keydown', event => {
    const typed = event.key.length === 1 && event.key !== ' ';
    if (!typed || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    openDraft(system, event.key);
  });
  item.append(button);
  return item;
}

function createDraftSlot() {
  const editing = draft.mode === 'edit';
  const item = createElement('li', 'game-entry game-draft');
  // An edit slot keeps the game's id, so it stays exactly where the game was.
  item.dataset.id = editing ? draft.gameId : 'draft';
  const details = createElement('div', 'game-entry-details');
  const title = createElement('input', 'draft-title');
  Object.assign(title, { name: 'title', value: draft.title, placeholder: 'Game name', maxLength: 100, autocomplete: 'off' });
  title.setAttribute('aria-label', editing ? 'Game name' : `New ${draft.system} game name`);
  const note = createElement('input', 'draft-note');
  Object.assign(note, { name: 'note', value: draft.note, placeholder: 'Note (optional)', maxLength: 280, autocomplete: 'off' });
  note.setAttribute('aria-label', 'Note (optional)');

  for (const input of [title, note]) {
    input.addEventListener('input', () => {
      draft[input.name] = input.value;
      // Typing again clears a "duplicate" error.
      if (draft.error) {
        draft.error = null;
        item.querySelector('.draft-error')?.remove();
      }
    });
    input.addEventListener('focus', () => { draft.focus = input.name; });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finishDraft({ refocus: true });
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelDraft({ refocus: true });
      }
    });
  }
  // Leaving the slot (not just moving between its two boxes) finishes the draft.
  // Ignore focus lost because the whole window lost focus, e.g. switching apps.
  item.addEventListener('focusout', event => {
    // Finishing redraws the list, which would swallow a click on another game's
    // button or a "+", so carry out that click here instead.
    const nextAction = actionFor(event.relatedTarget);
    setTimeout(() => {
      if (!draft || !item.isConnected || item.contains(document.activeElement) || !document.hasFocus()) return;
      draft.focus = null;
      if (finishDraft()) nextAction?.();
    });
  });

  details.append(title, note);
  item.append(details);
  if (draft.error) item.append(createDraftError(draft.error));
  return item;
}

function createDraftError(message) {
  const error = createElement('p', 'draft-error', message);
  error.setAttribute('role', 'alert');
  return error;
}

function isDuplicateTitle(title, exceptId) {
  return games.find(game => game.id !== exceptId && titleOrder.compare(game.title.trim(), title.trim()) === 0);
}

// Duplicate name: shake the slot, show a small error under it, and keep it open
// with the cursor back in the name box. Nothing is saved.
function rejectDraft(message) {
  draft.error = message;
  draft.focus = 'title';
  const slot = list.querySelector('.game-draft');
  if (!slot) return;
  slot.querySelector('.draft-error')?.remove();
  slot.append(createDraftError(message));
  const title = slot.querySelector('.draft-title');
  title.focus();
  title.setSelectionRange(title.value.length, title.value.length);
  playAnimation(slot, [
    { transform: 'translateX(0)' },
    { transform: 'translateX(-6px)' },
    { transform: 'translateX(6px)' },
    { transform: 'translateX(-4px)' },
    { transform: 'translateX(4px)' },
    { transform: 'translateX(-2px)' },
    { transform: 'translateX(0)' }
  ], { duration: 360, easing: 'ease-in-out' });
}

function actionFor(target) {
  const button = target?.closest?.('button');
  if (!button || !list.contains(button)) return null;
  const slotId = button.closest('[data-id]')?.dataset.id;
  if (button.classList.contains('game-add-button')) return () => openDraft(slotId.slice('add:'.length));
  if (button.classList.contains('edit-game')) return () => openEdit(slotId);
  if (button.classList.contains('remove-game')) return () => removeGame(slotId);
  return null;
}

// After Enter/Escape, put focus back on the button that opened the slot,
// so Enter on a "+" starts the next game straight away.
function refocusOpener(closed) {
  const selector = closed.mode === 'edit' ? '.edit-game' : '.game-add-button';
  const id = closed.mode === 'edit' ? closed.gameId : `add:${closed.system}`;
  findSlot(id)?.querySelector(selector)?.focus();
}

async function openDraft(system, initialTitle = '') {
  if (!canEdit() || !apiReady) return;
  if (draft && !draft.closing && !finishDraft()) return;
  draft = { mode: 'add', system, title: initialTitle, note: '', focus: 'title', closing: false };
  renderAndSlide({ draft: findSlot(`add:${system}`)?.getBoundingClientRect() });
  // Keep typing after any character that opened the slot.
  const title = list.querySelector('.game-draft .draft-title');
  title?.setSelectionRange(title.value.length, title.value.length);
  await pop(list.querySelector('.game-draft'), POP_IN, { duration: 240, easing: 'ease-out' });
}

async function openEdit(gameId) {
  if (!canEdit() || !apiReady) return;
  if (draft && !draft.closing && !finishDraft()) return;
  const game = games.find(entry => entry.id === gameId);
  if (!game) return;
  draft = {
    mode: 'edit',
    gameId,
    system: systemForGame(game),
    title: game.title,
    // The genre is shown in the note box too, so it can be changed there.
    note: noteWithCategory(game),
    focus: 'title',
    closing: false
  };
  renderAndSlide();
  const slot = list.querySelector('.game-draft');
  // Start with the cursor at the end of the existing name.
  const title = slot?.querySelector('.draft-title');
  title?.setSelectionRange(title.value.length, title.value.length);
  await pop(slot, POP_SWAP, { duration: 200, easing: 'ease-out' });
}

async function cancelDraft({ refocus = false } = {}) {
  if (!draft || draft.closing) return;
  const closing = draft;
  closing.closing = true;
  if (closing.mode === 'add') {
    await pop(list.querySelector('.game-draft'), POP_OUT, { duration: 240, easing: 'ease-in', fill: 'forwards' });
  }
  // A new slot may have been opened elsewhere while this one popped out.
  if (draft !== closing) return;
  draft = null;
  renderAndSlide();
  if (closing.mode === 'edit') pop(findSlot(closing.gameId), POP_SWAP, { duration: 200, easing: 'ease-out' });
  if (refocus) refocusOpener(closing);
}

// Returns false if the slot had to stay open (a duplicate name), true otherwise.
function finishDraft({ refocus = false } = {}) {
  if (!draft || draft.closing) return true;
  if (!draft.title.trim()) {
    cancelDraft({ refocus });
    return true;
  }
  const duplicate = isDuplicateTitle(draft.title, draft.mode === 'edit' ? draft.gameId : null);
  if (duplicate) {
    rejectDraft(`Already in the backlog (${systemForGame(duplicate)})`);
    return false;
  }
  if (draft.mode === 'edit') saveEdit({ refocus });
  else saveNewGame({ refocus });
  return true;
}

function saveNewGame({ refocus }) {
  const closing = draft;
  const game = {
    id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: cleanTitle(closing.title),
    platform: closing.system,
    // A genre typed in brackets is kept; otherwise the server asks Gemini (premium accounts only).
    ...splitNote(closing.note),
    createdAt: Date.now()
  };
  const draftPosition = list.querySelector('.game-draft')?.getBoundingClientRect();
  draft = null;
  games.push(game);
  // Clear the filters so the new game (which has no genre yet) is in view.
  searchInput.value = '';
  genreFilter = '';
  saveNote.textContent = 'Saving…';
  // The new game takes the draft's place; the "+" slides along after it.
  renderAndSlide(draftPosition ? { [game.id]: draftPosition } : {});
  if (refocus) refocusOpener(closing);

  account.request('POST', { game })
    .then(result => {
      games = games.map(entry => entry.id === game.id ? result.game : entry);
      // The server may have picked a genre, or dropped one that isn't a genre any more.
      if (result.game.category !== game.category) showCategory(result.game);
      saveNote.textContent = 'Backlog saved';
    })
    .catch(error => {
      games = games.filter(entry => entry.id !== game.id);
      if (error.status === 401) {
        signInExpired();
        return;
      }
      saveNote.textContent = `Could not add game: ${error.message}`;
      renderAndSlide();
    });
}

function saveEdit({ refocus }) {
  const closing = draft;
  draft = null;
  const original = games.find(entry => entry.id === closing.gameId);
  if (!original) {
    render();
    return;
  }
  // Deleting the brackets keeps the old genre; changing what's in them changes it.
  const { note, category } = splitNote(closing.note);
  const updated = {
    ...original,
    title: cleanTitle(closing.title),
    note,
    category: category || original.category || ''
  };
  const changed = updated.title !== original.title || updated.note !== (original.note || '')
    || updated.category !== (original.category || '');
  if (changed) games = games.map(entry => entry.id === original.id ? updated : entry);
  renderAndSlide();
  // If the new name moved it to a new alphabetical spot it's sliding there; only
  // pop it when it stayed put, as the two animations would fight.
  const slot = findSlot(original.id);
  if (!slot?.getAnimations().length) pop(slot, POP_SWAP, { duration: 200, easing: 'ease-out' });
  if (refocus) refocusOpener(closing);
  if (!changed) return;

  saveNote.textContent = 'Saving…';
  account.request('POST', { game: updated })
    .then(result => {
      games = games.map(entry => entry.id === original.id ? result.game : entry);
      if (result.game.category !== updated.category) showCategory(result.game);
      saveNote.textContent = 'Backlog saved';
    })
    .catch(error => {
      games = games.map(entry => entry.id === original.id ? original : entry);
      if (error.status === 401) {
        signInExpired();
        return;
      }
      saveNote.textContent = `Could not save changes: ${error.message}`;
      render();
    });
}

// ---------- Wiring ----------

searchInput.addEventListener('input', () => render());

document.addEventListener('site-account-change', () => {
  if (!canEdit()) draft = null;
  showAccountNote();
  render();
  // Signing in or out of a page with no ?user= switches to the right backlog.
  loadGamesFor(account.pageOwner());
});

showPageTitle();
render();
loadGamesFor(account.pageOwner());
