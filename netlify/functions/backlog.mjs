import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const STORE_NAME = 'public-game-backlog';
const ACCOUNT_STORE_NAME = 'backlog-accounts';
const KEY_PREFIX = 'game-';
const ACCOUNT_KEY_PREFIX = 'user-';
// Each account's settings (just its site colour so far), in the accounts store next to
// the account. The admin has one too, though its account lives in the environment.
const SETTINGS_KEY_PREFIX = 'settings-';
const MAX_GAMES = 500; // per backlog
const MAX_ACCOUNTS = 1000;
// The one admin account (password in the environment). Only the admin's games get
// genres from Gemini, and only the admin sees errors and Gemini usage on the Stats page.
const ADMIN_USERNAME = 'kiwamari';
const ADMIN_DISPLAY_NAME = 'Kiwamari';
// Page views and client/server errors shown on the About (stats) page.
const STATS_STORE_NAME = 'site-stats';
const VIEWS_KEY = 'views';
const ERRORS_KEY = 'errors';
const MAX_ERRORS = 50;
// Each game gets a genre from Google's Gemini API when it's saved (GEMINI_API_KEY in
// Netlify's environment variables). The "-latest" aliases always point at Google's
// current Flash models, so retired model versions never need changing here.
// GEMINI_MODEL can name a specific model to try first.
// Broad genres only; Gemini has to pick one of these. The prompt in askGemini
// explains Souls-Like and Builder, and that strategy games go under RPG.
const GAME_CATEGORIES = [
  'Action', 'Action RPG', 'Adventure', 'Builder', 'Fighting', 'Horror', 'Platformer', 'Puzzle',
  'Racing', 'RPG', 'Shooter', 'Simulation', 'Souls-Like', 'Sports', 'Other'
];
// Google has no API for remaining quota, so Gemini calls are counted here for the
// Stats page, per Pacific day because that's when Google resets daily limits.
// Kept forever, like page views: a day is only a few bytes.
const GEMINI_USAGE_KEY = 'gemini';
const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean);
// How long to wait for Gemini to answer. Netlify stops a request after 60 seconds,
// so all of the calls for one game have to finish inside GEMINI_TOTAL_MS; the backup
// model is only tried if there's still time left.
const GEMINI_TIMEOUT_MS = 30000;
const GEMINI_TOTAL_MS = 50000;
const GEMINI_MIN_TRY_MS = 5000;
// After Google says a model is over its limit (HTTP 429), leave that model alone
// for a while instead of spending more requests on errors.
const GEMINI_COOLDOWN_MS = 2 * 60 * 1000;
// A genre typed by hand can be anything this long, not just GAME_CATEGORIES.
const MAX_CATEGORY_LENGTH = 30;
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
    return { username, isAdmin: username === ADMIN_USERNAME };
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

function accountsStore() {
  return getStore({ name: ACCOUNT_STORE_NAME, consistency: 'strong' });
}

function displayName(username) {
  return username === ADMIN_USERNAME ? ADMIN_DISPLAY_NAME : username;
}

function settingsKey(username) {
  return `${SETTINGS_KEY_PREFIX}${accountKey(username).slice(ACCOUNT_KEY_PREFIX.length)}`;
}

// A site colour as "#rrggbb", or null if it isn't one.
function cleanColor(color) {
  return typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

// What the pages are told about the signed-in person. color is their own site colour
// (null for the default), which the pages use as the trim colour.
async function publicUser(username) {
  const settings = await accountsStore().get(settingsKey(username), { type: 'json' });
  return {
    username: displayName(username),
    isAdmin: username === ADMIN_USERNAME,
    color: cleanColor(settings?.color)
  };
}

// Everything the profile page shows. Anyone can see anyone's profile.
async function readProfile(username) {
  const isAdmin = username === ADMIN_USERNAME;
  const accounts = accountsStore();
  const [account, settings, games] = await Promise.all([
    isAdmin ? null : accounts.get(accountKey(username)),
    accounts.get(settingsKey(username)),
    listGames(getStore({ name: STORE_NAME, consistency: 'strong' }), username)
  ]);
  const bytes = text => (text ? Buffer.byteLength(text) : 0);
  return {
    username: displayName(username),
    isAdmin,
    // Set by hand for now: "premium": true in the account's record. The admin always is.
    isPremium: isAdmin || JSON.parse(account || '{}').premium === true,
    games: games.length,
    // Bytes as stored: each game's record, and the account's own record plus its settings.
    storage: {
      games: games.reduce((total, game) => total + bytes(JSON.stringify(game)), 0),
      account: bytes(account) + bytes(settings)
    },
    color: cleanColor(JSON.parse(settings || '{}').color)
  };
}

// Every account has its own backlog. The admin's games keep the keys they had before
// there were several backlogs ("game-<id>"); everyone else's are filed under their
// account ("user/<name>/game-<id>"), so each backlog can be listed on its own.
function backlogPrefix(username) {
  if (username === ADMIN_USERNAME) return KEY_PREFIX;
  return `user/${accountKey(username).slice(ACCOUNT_KEY_PREFIX.length)}/${KEY_PREFIX}`;
}

// The account a ?user= or ?profile= link names, as its stored (lower-case) username,
// or null if there's no such account.
async function findAccount(name) {
  const username = normalizeUsername(name);
  if (username === ADMIN_USERNAME) return username;
  if (!validUsername(username)) return null;
  const saved = await accountsStore().get(accountKey(username), { type: 'json' });
  return saved ? username : null;
}

async function listGames(store, username) {
  const { blobs } = await store.list({ prefix: backlogPrefix(username) });
  const games = await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })));
  return games.filter(Boolean);
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
    // Set by hand ("(RPG)" at the end of a note). Empty asks Gemini, for the admin only.
    category: typeof game.category === 'string' ? game.category.trim().slice(0, MAX_CATEGORY_LENGTH) : '',
    createdAt: Number.isFinite(game.createdAt) ? game.createdAt : Date.now()
  };
}

// ---------- Genres ----------

// Returns one of GAME_CATEGORIES, or '' if Gemini isn't set up or doesn't answer.
// Only the game's name is sent to Google, never its note or anything else.
// Failures are logged to the Stats page errors, and the game is saved without a
// genre so the backfill can try again later.
async function categorizeGame(game) {
  if (!process.env.GEMINI_API_KEY) {
    await logGeminiError('GEMINI_API_KEY is not set');
    return '';
  }
  const usage = await statsStore().get(GEMINI_USAGE_KEY, { type: 'json' }).catch(() => null);
  const models = GEMINI_MODELS.filter(model =>
    !(Date.now() - (usage?.limited?.[model] || 0) < GEMINI_COOLDOWN_MS));
  // Every model is cooling down after a 429; skip quietly, the backfill retries later.
  if (!models.length) return '';

  const started = Date.now();
  const timeLeft = () => Math.min(GEMINI_TIMEOUT_MS, GEMINI_TOTAL_MS - (Date.now() - started));
  const failures = [];
  for (const model of models) {
    if (timeLeft() < GEMINI_MIN_TRY_MS) {
      failures.push(`${model}: not tried, out of time`);
      break;
    }
    let timeout = timeLeft();
    try {
      // Thinking is turned down because it's slow and a genre doesn't need it. If a
      // future model rejects that setting (HTTP 400), ask again without it.
      let response = await askGemini(model, seriesTitle(game.title), true, timeout);
      if (response.status === 400 && timeLeft() >= GEMINI_MIN_TRY_MS) {
        timeout = timeLeft();
        response = await askGemini(model, seriesTitle(game.title), false, timeout);
      }
      if (!response.ok) {
        const detail = (await response.json().catch(() => null))?.error?.message || '';
        await recordGeminiCall(model, response.status === 429 ? 'limited' : 'failed');
        failures.push(`${model}: HTTP ${response.status}${detail ? ` (${detail.slice(0, 160)})` : ''}`);
        continue;
      }
      const result = await response.json();
      await recordGeminiCall(model, 'ok', result.usageMetadata?.totalTokenCount);
      const text = result.candidates?.[0]?.content?.parts
        ?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
      const category = (() => {
        try { return JSON.parse(text).category; } catch { return null; }
      })();
      if (GAME_CATEGORIES.includes(category)) return category;
      failures.push(`${model}: unexpected answer ${JSON.stringify(text.slice(0, 80))}`);
    } catch (error) {
      await recordGeminiCall(model, 'failed');
      failures.push(`${model}: ${error.name === 'TimeoutError' ? `no answer within ${Math.round(timeout / 1000)}s` : error.message}`);
    }
  }
  await logGeminiError(failures.join('; '));
  return '';
}

// Several games of a series share one slot by ending in numbers split by slashes
// ("Dark Souls 1/2/3"). Gemini is asked about the series name ("Dark Souls"), as
// "1/2/3" isn't part of any real title. Anything else is sent as it is.
function seriesTitle(title) {
  return title.replace(/\s*\d+(?:\s*\/\s*\d+)+\s*$/, '') || title;
}

function askGemini(model, title, lowThinking, timeout) {
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{
            text: `What genre is the video game "${title}"? Give its broad main genre, not a sub-genre.`
              + ' Except: if it\'s a soulslike (like Dark Souls, Sekiro or Code Vein),'
              + ' answer "Souls-Like". Building and sandbox games (like Minecraft) are "Builder".'
              + ' Strategy and tactics games count as "RPG".'
              + ' Answer "Other" if you don\'t recognise the game.'
          }]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { category: { type: 'STRING', enum: GAME_CATEGORIES } },
            required: ['category']
          },
          ...(lowThinking ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {})
        }
      })
    }
  );
}

async function logGeminiError(message) {
  console.error('Gemini categorization failed:', message);
  await recordError({ message: `Gemini: ${message}`, source: 'netlify function (categorize)', page: '' })
    .catch(() => {});
}

// usage = { days: { 'YYYY-MM-DD': { ok, limited, failed, tokens } }, lastLimitedAt,
//           limited: { model: time of its last 429 } }.
// outcome: 'ok', 'limited' (HTTP 429, over a Google limit) or 'failed'.
// tokens is Google's own count from the response (usageMetadata.totalTokenCount):
// the question, the answer and any thinking.
async function recordGeminiCall(model, outcome, tokens = 0) {
  const today = pacificDay.format(new Date());
  try {
    await updateJson(statsStore(), GEMINI_USAGE_KEY, (usage) => {
      const days = usage?.days || {};
      const day = { ok: 0, limited: 0, failed: 0, tokens: 0, ...days[today] };
      day[outcome]++;
      day.tokens += Number.isFinite(tokens) ? tokens : 0;
      days[today] = day;
      const limited = outcome === 'limited' ? Date.now() : null;
      return {
        days,
        lastLimitedAt: limited || usage?.lastLimitedAt || null,
        limited: { ...usage?.limited, ...(limited ? { [model]: limited } : {}) }
      };
    });
  } catch (error) {
    console.error('Could not record Gemini usage', error);
  }
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
// Kept forever: a day only adds a few bytes per page.
async function recordView(page) {
  const today = new Date().toISOString().slice(0, 10);
  await updateJson(statsStore(), VIEWS_KEY, (views) => {
    const totals = views?.totals || {};
    const days = views?.days || {};
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
  const accounts = accountsStore();
  const [views, { blobs }, errors, gemini] = await Promise.all([
    store.get(VIEWS_KEY, { type: 'json' }),
    accounts.list({ prefix: ACCOUNT_KEY_PREFIX }),
    session?.isAdmin ? store.get(ERRORS_KEY, { type: 'json' }) : null,
    session?.isAdmin ? store.get(GEMINI_USAGE_KEY, { type: 'json' }) : null
  ]);
  return {
    views: views || { totals: {}, days: {} },
    // The admin account lives in the environment, not in the store.
    accounts: blobs.length + 1,
    ...(session?.isAdmin ? {
      errors: errors || [],
      gemini: {
        ...(gemini || { days: {}, lastLimitedAt: null }),
        today: pacificDay.format(new Date()),
        configured: Boolean(process.env.GEMINI_API_KEY),
        // Optional: your daily request limit from AI Studio, to show usage against it.
        dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT) || null
      }
    } : {})
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

      let accountName;
      if (username === ADMIN_USERNAME) {
        if (body.action === 'register') return respond(request, 409, { error: 'That username is reserved' });
        if (!safeEqual(password, process.env.BACKLOG_PASSWORD)) {
          return respond(request, 401, { error: 'Incorrect username or password' });
        }
        accountName = ADMIN_USERNAME;
      } else {
        const accounts = accountsStore();
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
          accountName = username;
        } else {
          const savedAccount = await accounts.get(key, { type: 'json' });
          if (!savedAccount) return respond(request, 404, { error: 'Account does not exist' });
          if (!await verifyPassword(password, savedAccount)) return respond(request, 401, { error: 'Password is incorrect' });
          accountName = savedAccount.username;
        }
      }

      return respond(request, 200, {
        token: createSession(accountName),
        user: await publicUser(accountName)
      });
    }

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const session = getSession(request);
      const user = session ? await publicUser(session.username) : null;
      if (params.has('session')) {
        return respond(request, 200, { user });
      }
      // Errors are only included for the admin.
      if (params.has('stats')) {
        return respond(request, 200, await readStats(session));
      }
      // The visitor's own IP and rough location, from Netlify. Not stored.
      if (params.has('whoami')) {
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

      // ?profile=name: that account's profile page details.
      if (params.has('profile')) {
        const username = await findAccount(params.get('profile'));
        if (!username) return respond(request, 404, { error: 'There is no account with that name' });
        return respond(request, 200, { profile: await readProfile(username) });
      }

      // ?user=name lists that person's backlog. Without it, the admin's, which is
      // what visitors see by default and what the Stats page counts.
      const owner = params.has('user') ? await findAccount(params.get('user')) : ADMIN_USERNAME;
      if (!owner) return respond(request, 404, { error: 'There is no account with that name' });
      const store = getStore({ name: STORE_NAME, consistency: 'strong' });
      return respond(request, 200, {
        games: await listGames(store, owner),
        owner: { username: displayName(owner) },
        user
      });
    }

    if (!secretsConfigured()) return respond(request, 503, { error: 'Login is not configured yet' });
    const session = getSession(request);
    if (!session) return respond(request, 401, { error: 'Please sign in again' });

    if (request.method === 'POST' && body?.action === 'clear-errors') {
      if (!session.isAdmin) return respond(request, 403, { error: 'Only the admin can clear errors' });
      await statsStore().setJSON(ERRORS_KEY, []);
      return respond(request, 200, { cleared: true });
    }

    // The signed-in person's own site colour; an empty colour goes back to the default.
    if (request.method === 'POST' && body?.action === 'set-color') {
      const color = body.color === '' ? null : cleanColor(body.color);
      if (color === null && body.color !== '') return respond(request, 400, { error: 'Invalid colour' });
      await updateJson(accountsStore(), settingsKey(session.username), settings => ({ ...settings, color }));
      return respond(request, 200, { color });
    }

    // Everything below changes the signed-in person's own backlog, never anyone else's.
    const store = getStore({ name: STORE_NAME, consistency: 'strong' });
    const prefix = backlogPrefix(session.username);

    // Sent by js/backlog.js, one game at a time and spaced out, for the admin's games
    // that have no genre yet (added before genres existed, or while Gemini was down).
    if (request.method === 'POST' && body?.action === 'categorize') {
      if (!session.isAdmin) return respond(request, 403, { error: 'Automatic genres are only available to the admin' });
      if (!validId(body.id)) return respond(request, 400, { error: 'Invalid game id' });
      const key = `${prefix}${body.id}`;
      const saved = await store.getWithMetadata(key, { type: 'json' });
      const game = saved?.data;
      if (!game || game.category) return respond(request, 200, { game: game || null });
      const category = await categorizeGame(game);
      if (!category) return respond(request, 200, { game }); // Gemini unavailable; try again next time.
      const categorized = { ...game, category };
      // Don't save over the game if it was edited or removed while Gemini was answering.
      const result = await store.set(key, JSON.stringify(categorized), {
        metadata: { title: game.title },
        onlyIfMatch: saved.etag
      });
      return respond(request, 200, { game: result.modified ? categorized : null });
    }

    if (request.method === 'POST') {
      const game = cleanGame(body.game);
      if (!game) return respond(request, 400, { error: 'Invalid game entry' });

      const key = `${prefix}${game.id}`;
      const existing = await store.get(key, { type: 'json' });
      if (!existing) {
        const { blobs } = await store.list({ prefix });
        if (blobs.length >= MAX_GAMES) return respond(request, 413, { error: 'Backlog is full' });
      }
      // A genre typed by hand wins. Otherwise, for the admin only, Gemini is asked once
      // per game: once a game has a genre, edits (even renames) keep it.
      game.category = game.category || existing?.category
        || (session.isAdmin ? await categorizeGame(game) : '');

      await store.set(key, JSON.stringify(game), {
        metadata: { title: game.title }
      });
      return respond(request, 201, { game });
    }

    if (request.method === 'DELETE') {
      if (!validId(body.id)) return respond(request, 400, { error: 'Invalid game id' });

      await store.delete(`${prefix}${body.id}`);
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
        const savedAccount = await accountsStore().get(pendingRegistration.key, { type: 'json' });
        if (await verifyPassword(pendingRegistration.password, savedAccount)) {
          return respond(request, 200, {
            token: createSession(pendingRegistration.username),
            user: await publicUser(pendingRegistration.username)
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