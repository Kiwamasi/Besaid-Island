// Local testing only: when the site is opened from localhost or file://, requests to
// SITE_API_URL are answered in the browser instead of by the Netlify function, and
// you start signed in as the admin account. Games and accounts live in localStorage,
// with a backlog for each account, like the real site.
// Signing out behaves like the real site; sign in as "kiwamari" with any password to
// become admin again. Add ?mock=off to the URL to use the real API (?mock=on to undo).
(() => {
  const { protocol, hostname, search } = window.location;
  const isLocal = protocol === 'file:' || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
  const override = new URLSearchParams(search).get('mock');
  if (override === 'off' || override === 'on') localStorage.setItem('besaid-mock', override);
  const setting = localStorage.getItem('besaid-mock');
  if (setting === 'off' || (!isLocal && setting !== 'on')) return;

  const apiUrl = String(window.SITE_API_URL || '').trim().replace(/\/$/, '');
  if (!apiUrl) return;

  // Shared with js/site-account.js.
  const SESSION_KEY = 'besaid-backlog-session';

  const GAMES_KEY = 'besaid-mock-backlog';
  const ACCOUNTS_KEY = 'besaid-mock-accounts';
  const SEEDED_KEY = 'besaid-mock-admin-seeded';
  const VIEWS_KEY = 'besaid-mock-views';
  const ERRORS_KEY = 'besaid-mock-errors';
  const GEMINI_KEY = 'besaid-mock-gemini';
  // { username: { color } }: each account's settings, the admin's included.
  const SETTINGS_KEY = 'besaid-mock-settings';
  const TOKEN_PREFIX = 'local-mock.';
  const ADMIN_USERNAME = 'kiwamari';
  const MAX_GAMES = 500; // per backlog

  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function tokenFor(username) {
    return `${TOKEN_PREFIX}${encodeURIComponent(username)}`;
  }

  // Start every fresh local browser (or one holding a real-API token) signed in as admin,
  // exactly as if the admin had logged in. After that the session persists like a real
  // one, so signing out sticks until you sign in again.
  const existingToken = localStorage.getItem(SESSION_KEY);
  const hasMockToken = existingToken?.startsWith(TOKEN_PREFIX);
  if (!localStorage.getItem(SEEDED_KEY) || (existingToken && !hasMockToken)) {
    localStorage.setItem(SESSION_KEY, tokenFor(ADMIN_USERNAME));
    localStorage.setItem(SEEDED_KEY, '1');
  }

  function displayName(username) {
    return username === ADMIN_USERNAME ? 'Kiwamari' : username;
  }

  function cleanColor(color) {
    return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
  }

  function settingsFor(username) {
    return read(SETTINGS_KEY, {})[username] || null;
  }

  function publicUser(username) {
    return {
      username: displayName(username),
      isAdmin: username === ADMIN_USERNAME,
      color: cleanColor(settingsFor(username)?.color)
    };
  }

  // Mirrors readProfile in netlify/functions/backlog.mjs. To try a premium account
  // locally, add "premium": true to its entry in the besaid-mock-accounts storage.
  function readProfile(username) {
    const isAdmin = username === ADMIN_USERNAME;
    const account = isAdmin ? null : read(ACCOUNTS_KEY, {})[username];
    const settings = settingsFor(username);
    const games = read(gamesKey(username), []);
    const bytes = value => (value ? new TextEncoder().encode(JSON.stringify(value)).length : 0);
    return {
      username: displayName(username),
      isAdmin,
      isPremium: isAdmin || account?.premium === true,
      games: games.length,
      storage: {
        games: games.reduce((total, game) => total + bytes(game), 0),
        account: bytes(account) + bytes(settings)
      },
      color: cleanColor(settings?.color)
    };
  }

  // The admin's games keep the original key, so an existing local backlog stays the
  // admin's; every other account gets its own.
  function gamesKey(username) {
    return username === ADMIN_USERNAME ? GAMES_KEY : `${GAMES_KEY}:${username}`;
  }

  // The account a ?user= or ?profile= link names (lower-case), or null.
  function findAccount(name) {
    const username = String(name || '').trim().toLowerCase();
    if (username === ADMIN_USERNAME) return username;
    return username && read(ACCOUNTS_KEY, {})[username] ? username : null;
  }

  function sessionUser(headers) {
    const authorization = new Headers(headers).get('authorization') || '';
    if (!authorization.startsWith(`Bearer ${TOKEN_PREFIX}`)) return null;
    let username;
    try {
      username = decodeURIComponent(authorization.slice(`Bearer ${TOKEN_PREFIX}`.length));
    } catch {
      return null;
    }
    if (username !== ADMIN_USERNAME && !read(ACCOUNTS_KEY, {})[username]) return null;
    return { ...publicUser(username), account: username };
  }

  function validId(id) {
    return typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
  }

  // Mirrors cleanGame in netlify/functions/backlog.mjs.
  function cleanGame(game) {
    if (!game || !validId(game.id) || typeof game.title !== 'string') return null;
    const title = game.title.trim();
    if (!title || title.length > 100) return null;
    return {
      id: game.id,
      title,
      platform: typeof game.platform === 'string' ? game.platform.trim().slice(0, 60) : '',
      note: typeof game.note === 'string' ? game.note.trim().slice(0, 240) : '',
      category: typeof game.category === 'string' ? game.category.trim().slice(0, 30) : '',
      createdAt: Number.isFinite(game.createdAt) ? game.createdAt : Date.now()
    };
  }

  // Stands in for Gemini: picks a genre from the name, so the same name always gets
  // the same (made-up) genre. The real list is GAME_CATEGORIES in the Netlify function.
  // Each pick counts as a call in the Stats page's Gemini usage. '' is Gemini answering
  // one of the removed genres (Other, Simulation): no genre, and not asked again.
  const MOCK_CATEGORIES = ['Action', 'Action RPG', 'Adventure', 'Platformer', 'Puzzle', 'RPG', 'Shooter', 'Souls-Like', ''];
  const REMOVED_GENRES = ['Other', 'Simulation'];

  // Mirrors withoutRemovedGenre in netlify/functions/backlog.mjs.
  function withoutRemovedGenre(game) {
    const removed = REMOVED_GENRES.some(genre => genre.toLowerCase() === game.category?.toLowerCase());
    return removed ? { ...game, category: '', noGenre: true } : game;
  }
  function mockCategory(title) {
    const usage = read(GEMINI_KEY, { days: {}, lastLimitedAt: null });
    const today = mockGeminiDay();
    usage.days[today] = { ok: 0, limited: 0, failed: 0, tokens: 0, ...usage.days[today] };
    usage.days[today].ok++;
    usage.days[today].tokens += 120;
    localStorage.setItem(GEMINI_KEY, JSON.stringify(usage));
    const sum = [...title].reduce((total, char) => total + char.charCodeAt(0), 0);
    return MOCK_CATEGORIES[sum % MOCK_CATEGORIES.length];
  }

  function mockGeminiDay() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  }

  function json(status, body) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  // Same routes, status codes and error messages as netlify/functions/backlog.mjs.
  function handle(url, options) {
    const method = String(options.method || 'GET').toUpperCase();
    let body = null;
    if (['POST', 'DELETE'].includes(method)) {
      try {
        body = JSON.parse(options.body);
      } catch {
        return json(500, { error: 'Backlog storage is unavailable' });
      }
    }

    if (method === 'POST' && body?.action === 'view') {
      if (typeof body.page !== 'string' || !/^[a-zA-Z0-9_-]{1,80}\.html$/.test(body.page)) {
        return json(400, { error: 'Invalid page' });
      }
      const views = read(VIEWS_KEY, { totals: {}, days: {} });
      const today = new Date().toISOString().slice(0, 10);
      views.totals[body.page] = (views.totals[body.page] || 0) + 1;
      views.days[today] = { ...views.days[today], [body.page]: (views.days[today]?.[body.page] || 0) + 1 };
      localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
      return json(200, { recorded: true });
    }
    if (method === 'POST' && body?.action === 'error') {
      const errors = read(ERRORS_KEY, []);
      const error = {
        message: String(body.message || 'Unknown error').slice(0, 300),
        source: String(body.source || '').slice(0, 200),
        line: Number.isInteger(body.line) && body.line > 0 ? body.line : null,
        page: String(body.page || '').slice(0, 80),
        at: Date.now()
      };
      const same = errors.find(entry => entry.message === error.message
        && entry.source === error.source && entry.line === error.line);
      const next = [{ ...error, count: (same?.count || 0) + 1 }, ...errors.filter(entry => entry !== same)];
      localStorage.setItem(ERRORS_KEY, JSON.stringify(next.slice(0, 50)));
      return json(200, { recorded: true });
    }

    if (method === 'POST' && ['login', 'register'].includes(body?.action)) {
      const suppliedUsername = typeof body.username === 'string' ? body.username.trim() : '';
      const username = suppliedUsername.toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!suppliedUsername || suppliedUsername.length > 128) {
        return json(400, { error: 'Username cannot be blank and must be 128 characters or fewer' });
      }
      if (!password || password.length > 128) {
        return json(400, { error: 'Password must be 1–128 characters' });
      }

      const accounts = read(ACCOUNTS_KEY, {});
      if (username === ADMIN_USERNAME) {
        if (body.action === 'register') return json(409, { error: 'That username is reserved' });
        // Any password is accepted for the admin account locally.
      } else if (body.action === 'register') {
        if (accounts[username]) return json(409, { error: 'That username is already taken' });
        accounts[username] = { password };
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      } else {
        if (!accounts[username]) return json(404, { error: 'Account does not exist' });
        if (accounts[username].password !== password) return json(401, { error: 'Password is incorrect' });
      }
      return json(200, { token: tokenFor(username), user: publicUser(username) });
    }

    if (method === 'GET') {
      const session = sessionUser(options.headers);
      const user = session && publicUser(session.account);
      if (url.searchParams.has('session')) return json(200, { user });
      if (url.searchParams.has('whoami')) {
        return json(200, {
          ip: '127.0.0.1',
          city: 'Local',
          region: null,
          country: 'Mock API',
          countryCode: null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
      }
      if (url.searchParams.has('stats')) {
        return json(200, {
          views: read(VIEWS_KEY, { totals: {}, days: {} }),
          accounts: Object.keys(read(ACCOUNTS_KEY, {})).length + 1,
          ...(user?.isAdmin ? {
            errors: read(ERRORS_KEY, []),
            gemini: {
              ...read(GEMINI_KEY, { days: {}, lastLimitedAt: null }),
              today: mockGeminiDay(),
              configured: true,
              dailyLimit: null
            }
          } : {})
        });
      }
      if (url.searchParams.has('users')) {
        const usernames = Object.keys(read(ACCOUNTS_KEY, {}))
          .sort((first, second) => first.localeCompare(second, undefined, { numeric: true, sensitivity: 'base' }));
        return json(200, {
          users: [ADMIN_USERNAME, ...usernames].map(username => ({
            username: displayName(username),
            isAdmin: username === ADMIN_USERNAME
          }))
        });
      }
      if (url.searchParams.has('profile')) {
        const username = findAccount(url.searchParams.get('profile'));
        if (!username) return json(404, { error: 'There is no account with that name' });
        return json(200, { profile: readProfile(username) });
      }
      const owner = url.searchParams.has('user') ? findAccount(url.searchParams.get('user')) : ADMIN_USERNAME;
      if (!owner) return json(404, { error: 'There is no account with that name' });
      return json(200, { games: read(gamesKey(owner), []).map(withoutRemovedGenre), owner: { username: displayName(owner) }, user });
    }

    const session = sessionUser(options.headers);
    if (!session) return json(401, { error: 'Please sign in again' });

    if (method === 'POST' && body?.action === 'clear-errors') {
      if (!session.isAdmin) return json(403, { error: 'Only the admin can clear errors' });
      localStorage.setItem(ERRORS_KEY, '[]');
      return json(200, { cleared: true });
    }

    if (method === 'POST' && body?.action === 'delete-user') {
      if (!session.isAdmin) return json(403, { error: 'Only the admin can delete accounts' });
      const username = findAccount(body.username);
      if (!username) return json(404, { error: 'There is no account with that name' });
      if (username === ADMIN_USERNAME) return json(400, { error: 'The admin account cannot be deleted' });
      const accounts = read(ACCOUNTS_KEY, {});
      delete accounts[username];
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      const settings = read(SETTINGS_KEY, {});
      delete settings[username];
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.removeItem(gamesKey(username));
      return json(200, { deleted: true });
    }

    if (method === 'POST' && body?.action === 'set-color') {
      const color = body.color === '' ? null : cleanColor(body.color);
      if (color === null && body.color !== '') return json(400, { error: 'Invalid colour' });
      const settings = read(SETTINGS_KEY, {});
      settings[session.account] = { ...settings[session.account], color };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return json(200, { color });
    }

    // Changes only ever go to the signed-in account's own backlog.
    const key = gamesKey(session.account);
    const games = read(key, []);

    if (method === 'POST' && body?.action === 'categorize') {
      if (!session.isAdmin) return json(403, { error: 'Automatic genres are only available to the admin' });
      if (!validId(body.id)) return json(400, { error: 'Invalid game id' });
      const index = games.findIndex(entry => entry.id === body.id);
      if (index === -1) return json(200, { game: null });
      let game = withoutRemovedGenre(games[index]);
      if (!game.category && !game.noGenre) {
        const category = mockCategory(game.title);
        game = category ? { ...game, category } : { ...game, noGenre: true };
        games[index] = game;
        localStorage.setItem(key, JSON.stringify(games));
      }
      return json(200, { game });
    }

    if (method === 'POST') {
      const cleaned = cleanGame(body.game);
      if (!cleaned) return json(400, { error: 'Invalid game entry' });
      const game = withoutRemovedGenre(cleaned);
      const index = games.findIndex(entry => entry.id === game.id);
      if (index === -1 && games.length >= MAX_GAMES) return json(413, { error: 'Backlog is full' });
      const previous = games[index] && withoutRemovedGenre(games[index]);
      if (!game.category && !game.noGenre && previous) {
        game.category = previous.category || '';
        if (previous.noGenre) game.noGenre = true;
      }
      if (!game.category && !game.noGenre && session.isAdmin) {
        const category = mockCategory(game.title);
        if (category) game.category = category;
        else game.noGenre = true;
      }
      if (index === -1) games.push(game);
      else games[index] = game;
      localStorage.setItem(key, JSON.stringify(games));
      return json(201, { game });
    }

    if (method === 'DELETE') {
      if (!validId(body.id)) return json(400, { error: 'Invalid game id' });
      localStorage.setItem(key, JSON.stringify(games.filter(entry => entry.id !== body.id)));
      return json(200, { deleted: true });
    }

    return json(405, { error: 'Method not allowed' });
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (`${url.origin}${url.pathname}`.replace(/\/$/, '') !== apiUrl) return realFetch(input, options);
    // Small delay so the "Checking account…" / "Saving…" states still show.
    await new Promise(resolve => setTimeout(resolve, 150));
    return handle(url, options);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const badge = document.createElement('div');
    badge.textContent = 'Local mock API';
    badge.title = 'Backlog and accounts are stored in this browser only. Add ?mock=off to the URL to use the real API.';
    badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9999;padding:4px 10px;'
      + 'border-radius:999px;background:#b45309;color:#fff;font:600 12px system-ui,sans-serif;opacity:.85;pointer-events:none';
    document.body.append(badge);
  });
})();
