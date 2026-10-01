// Local testing only: when the site is opened from localhost or file://, requests to
// SITE_API_URL are answered in the browser instead of by the Netlify function, and
// you start signed in as the admin account. Games and accounts live in localStorage.
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
  const TOKEN_PREFIX = 'local-mock.';
  const ADMIN_USERNAME = 'kiwamari';
  const MAX_GAMES = 500;

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

  function publicUser(username) {
    return username === ADMIN_USERNAME
      ? { username: 'Kiwamari', canEdit: true }
      : { username, canEdit: false };
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
    return publicUser(username);
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
      createdAt: Number.isFinite(game.createdAt) ? game.createdAt : Date.now()
    };
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
    const games = read(GAMES_KEY, []);

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
      const user = sessionUser(options.headers);
      if (url.searchParams.has('session')) return json(200, { user });
      return json(200, { games, user });
    }

    const user = sessionUser(options.headers);
    if (!user) return json(401, { error: 'Please sign in again' });
    if (!user.canEdit) return json(403, { error: 'Only admins can edit the backlog' });

    if (method === 'POST') {
      const game = cleanGame(body.game);
      if (!game) return json(400, { error: 'Invalid game entry' });
      const index = games.findIndex(entry => entry.id === game.id);
      if (index === -1 && games.length >= MAX_GAMES) return json(413, { error: 'Backlog is full' });
      if (index === -1) games.push(game);
      else games[index] = game;
      localStorage.setItem(GAMES_KEY, JSON.stringify(games));
      return json(201, { game });
    }

    if (method === 'DELETE') {
      if (!validId(body.id)) return json(400, { error: 'Invalid game id' });
      localStorage.setItem(GAMES_KEY, JSON.stringify(games.filter(entry => entry.id !== body.id)));
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
