import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const STORE_NAME = 'public-game-backlog';
const ACCOUNT_STORE_NAME = 'backlog-accounts';
const KEY_PREFIX = 'game-';
const ACCOUNT_KEY_PREFIX = 'user-';
const MAX_GAMES = 500;
const MAX_ACCOUNTS = 1000;
const ADMIN_USERNAME = 'kiwamari';
// Page views and client/server errors shown on the About (stats) page.
const STATS_STORE_NAME = 'site-stats';
const VIEWS_KEY = 'views';
const ERRORS_KEY = 'errors';
const VIEW_DAYS_KEPT = 371;
const MAX_ERRORS = 50;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://kiwamasi.github.io';
const scrypt = promisify(scryptCallback);
const HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function corsHeaders(request) {
  const requestOrigin = request.headers.get('origin');
  return {
    ...HEADERS,
    'Access-Control-Allow-Origin': requestOrigin === ALLOWED_ORIGIN ? requestOrigin : ALLOWED_ORIGIN,
    Vary: 'Origin'
  };
}

function respond(request, statusCode, body) {
  return new Response(JSON.stringify(body), { status: statusCode, headers: corsHeaders(request) });
}

function secretsConfigured() {
  return Boolean(
    process.env.BACKLOG_PASSWORD
    && process.env.SESSION_SECRET
    && process.env.SESSION_SECRET.length >= 32
  );
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET)
    .update(payload)
    .digest('base64url');
}

function createSession(username) {
  const payload = Buffer.from(JSON.stringify({ sub: username })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function getSession(request) {
  if (!process.env.SESSION_SECRET) return null;
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;

  const [payload, providedSignature, extra] = authorization.slice(7).split('.');
  if (!payload || !providedSignature || extra !== undefined) return null;

  const expectedSignature = sign(payload);
  if (!safeEqual(providedSignature, expectedSignature)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof session.sub !== 'string') return null;
    if (session.exp && session.exp <= Math.floor(Date.now() / 1000)) return null;
    const username = normalizeUsername(session.sub);
    return { username, canEdit: username === ADMIN_USERNAME };
  } catch {
    return null;
  }
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function validUsername(username) {
  return typeof username === 'string' && username.length > 0 && username.length <= 128;
}

function accountKey(username) {
  if (/^[a-zA-Z0-9_-]{3,24}$/.test(username)) return `${ACCOUNT_KEY_PREFIX}${username}`;
  return `${ACCOUNT_KEY_PREFIX}~${Buffer.from(username, 'utf8').toString('base64url')}`;
}

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const derivedKey = await scrypt(password, salt, 64);
  return { salt, hash: Buffer.from(derivedKey).toString('hex') };
}

async function verifyPassword(password, stored) {
  if (!stored || typeof stored.salt !== 'string' || typeof stored.hash !== 'string') return false;
  const derivedKey = await scrypt(password, stored.salt, 64);
  return safeEqual(Buffer.from(derivedKey).toString('hex'), stored.hash);
}

function validId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
}

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

// ---------- Site stats ----------

function statsStore() {
  return getStore({ name: STATS_STORE_NAME, consistency: 'strong' });
}

// Read-modify-write that retries if another request changed the blob in between.
async function updateJson(store, key, change) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(key, { type: 'json' });
    const next = change(existing?.data ?? null);
    const result = existing
      ? await store.setJSON(key, next, { onlyIfMatch: existing.etag })
      : await store.setJSON(key, next, { onlyIfNew: true });
    if (result.modified) return;
  }
  throw new Error(`Could not update ${key}`);
}

function validPage(page) {
  return typeof page === 'string' && /^[a-zA-Z0-9_-]{1,80}\.html$/.test(page);
}

// views = { totals: { page: n }, days: { 'YYYY-MM-DD': { page: n } } } (UTC days).
async function recordView(page) {
  const today = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - VIEW_DAYS_KEPT * 86400000).toISOString().slice(0, 10);
  await updateJson(statsStore(), VIEWS_KEY, (views) => {
    const totals = views?.totals || {};
    const days = {};
    for (const [day, pages] of Object.entries(views?.days || {})) {
      if (day >= oldest) days[day] = pages;
    }
    totals[page] = (totals[page] || 0) + 1;
    days[today] = { ...days[today], [page]: (days[today]?.[page] || 0) + 1 };
    return { totals, days };
  });
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// Newest first. A repeat of the same error bumps its count instead of adding a row.
async function recordError(report) {
  const error = {
    message: cleanText(report.message, 300) || 'Unknown error',
    source: cleanText(report.source, 200),
    line: Number.isInteger(report.line) && report.line > 0 ? report.line : null,
    page: cleanText(report.page, 80),
    at: Date.now()
  };
  await updateJson(statsStore(), ERRORS_KEY, (errors) => {
    const list = Array.isArray(errors) ? errors : [];
    const same = list.find(entry => entry.message === error.message
      && entry.source === error.source && entry.line === error.line);
    const count = (same?.count || 0) + 1;
    return [{ ...error, count }, ...list.filter(entry => entry !== same)].slice(0, MAX_ERRORS);
  });
}

async function readStats(session) {
  const store = statsStore();
  const accounts = getStore({ name: ACCOUNT_STORE_NAME, consistency: 'strong' });
  const [views, { blobs }, errors] = await Promise.all([
    store.get(VIEWS_KEY, { type: 'json' }),
    accounts.list({ prefix: ACCOUNT_KEY_PREFIX }),
    session?.canEdit ? store.get(ERRORS_KEY, { type: 'json' }) : null
  ]);
  return {
    views: views || { totals: {}, days: {} },
    // The admin account lives in the environment, not in the store.
    accounts: blobs.length + 1,
    ...(session?.canEdit ? { errors: errors || [] } : {})
  };
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  let pendingRegistration = null;
  try {
    const body = ['POST', 'DELETE'].includes(request.method) ? await request.json() : null;

    // Sent by js/site-telemetry.js from every page; no sign-in needed.
    if (request.method === 'POST' && body?.action === 'view') {
      if (!validPage(body.page)) return respond(request, 400, { error: 'Invalid page' });
      await recordView(body.page);
      return respond(request, 200, { recorded: true });
    }
    if (request.method === 'POST' && body?.action === 'error') {
      await recordError(body);
      return respond(request, 200, { recorded: true });
    }

    if (request.method === 'POST' && ['login', 'register'].includes(body?.action)) {
      if (!secretsConfigured()) return respond(request, 503, { error: 'Account service is not configured yet' });

      const suppliedUsername = typeof body.username === 'string' ? body.username.trim() : '';
      const username = normalizeUsername(suppliedUsername);
      const password = typeof body.password === 'string' ? body.password : '';
      if (!validUsername(suppliedUsername)) {
        return respond(request, 400, { error: 'Username cannot be blank and must be 128 characters or fewer' });
      }
      if (!password || password.length > 128) {
        return respond(request, 400, { error: 'Password must be 1–128 characters' });
      }

      let account;
      if (username === ADMIN_USERNAME) {
        if (body.action === 'register') return respond(request, 409, { error: 'That username is reserved' });
        if (!safeEqual(password, process.env.BACKLOG_PASSWORD)) {
          return respond(request, 401, { error: 'Incorrect username or password' });
        }
        account = { username: ADMIN_USERNAME, canEdit: true };
      } else {
        const accounts = getStore({ name: ACCOUNT_STORE_NAME, consistency: 'strong' });
        const key = accountKey(username);

        if (body.action === 'register') {
          const { blobs } = await accounts.list({ prefix: ACCOUNT_KEY_PREFIX });
          if (blobs.length >= MAX_ACCOUNTS) {
            return respond(request, 429, { error: 'Account registration is currently full' });
          }
          const credentials = await hashPassword(password);
          pendingRegistration = { username, key, password };
          const created = await accounts.set(key, JSON.stringify({ username, ...credentials }), {
            onlyIfNew: true
          });
          if (!created.modified) return respond(request, 409, { error: 'That username is already taken' });
          account = { username, canEdit: false };
        } else {
          const savedAccount = await accounts.get(key, { type: 'json' });
          if (!savedAccount) return respond(request, 404, { error: 'Account does not exist' });
          if (!await verifyPassword(password, savedAccount)) return respond(request, 401, { error: 'Password is incorrect' });
          account = { username: savedAccount.username, canEdit: false };
        }
      }

      return respond(request, 200, {
        token: createSession(account.username),
        user: {
          username: account.canEdit ? 'Kiwamari' : account.username,
          canEdit: account.canEdit
        }
      });
    }

    if (request.method === 'GET') {
      const session = getSession(request);
      const user = session ? {
        username: session.canEdit ? 'Kiwamari' : session.username,
        canEdit: session.canEdit
      } : null;
      if (new URL(request.url).searchParams.has('session')) {
        return respond(request, 200, { user });
      }
      // Errors are only included for the admin.
      if (new URL(request.url).searchParams.has('stats')) {
        return respond(request, 200, await readStats(session));
      }
      // The visitor's own IP and rough location, from Netlify. Not stored.
      if (new URL(request.url).searchParams.has('whoami')) {
        const geo = context?.geo || {};
        return respond(request, 200, {
          ip: context?.ip || request.headers.get('x-nf-client-connection-ip') || null,
          city: geo.city || null,
          region: geo.subdivision?.name || null,
          country: geo.country?.name || null,
          countryCode: geo.country?.code || null,
          timezone: geo.timezone || null
        });
      }

      const store = getStore({ name: STORE_NAME, consistency: 'strong' });
      const { blobs } = await store.list({ prefix: KEY_PREFIX });
      const games = await Promise.all(blobs.map(async ({ key }) =>
        store.get(key, { type: 'json' })
      ));
      return respond(request, 200, { games: games.filter(Boolean), user });
    }

    if (!secretsConfigured()) return respond(request, 503, { error: 'Login is not configured yet' });
    const session = getSession(request);
    if (!session) return respond(request, 401, { error: 'Please sign in again' });
    if (!session.canEdit) return respond(request, 403, { error: 'Only admins can edit the backlog' });

    const store = getStore({ name: STORE_NAME, consistency: 'strong' });

    if (request.method === 'POST' && body?.action === 'clear-errors') {
      await statsStore().setJSON(ERRORS_KEY, []);
      return respond(request, 200, { cleared: true });
    }

    if (request.method === 'POST') {
      const game = cleanGame(body.game);
      if (!game) return respond(request, 400, { error: 'Invalid game entry' });

      const key = `${KEY_PREFIX}${game.id}`;
      const existing = await store.get(key);
      if (!existing) {
        const { blobs } = await store.list({ prefix: KEY_PREFIX });
        if (blobs.length >= MAX_GAMES) return respond(request, 413, { error: 'Backlog is full' });
      }

      await store.set(key, JSON.stringify(game), {
        metadata: { title: game.title }
      });
      return respond(request, 201, { game });
    }

    if (request.method === 'DELETE') {
      if (!validId(body.id)) return respond(request, 400, { error: 'Invalid game id' });

      await store.delete(`${KEY_PREFIX}${body.id}`);
      return respond(request, 200, { deleted: true });
    }

    return respond(request, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Backlog storage request failed', error);
    try {
      await recordError({ message: `API: ${error.message}`, source: `netlify function (${request.method})`, page: '' });
    } catch {
      // Storage itself may be what failed; the console log above still has it.
    }
    if (pendingRegistration) {
      try {
        const accounts = getStore({ name: ACCOUNT_STORE_NAME, consistency: 'strong' });
        const savedAccount = await accounts.get(pendingRegistration.key, { type: 'json' });
        if (await verifyPassword(pendingRegistration.password, savedAccount)) {
          return respond(request, 200, {
            token: createSession(pendingRegistration.username),
            user: { username: pendingRegistration.username, canEdit: false }
          });
        }
      } catch (recoveryError) {
        console.error('Account registration recovery failed', recoveryError);
      }
      return respond(request, 500, {
        error: 'Account creation could not be confirmed. Try signing in with that username before attempting to register again.'
      });
    }
    return respond(request, 500, { error: 'Backlog storage is unavailable' });
  }
};