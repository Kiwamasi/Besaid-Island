import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { octopusConfigured, readEnergySummary } from '../lib/octopus.mjs';

const STORE_NAME = 'public-game-backlog';
const ACCOUNT_STORE_NAME = 'backlog-accounts';
const KEY_PREFIX = 'game-';
const ACCOUNT_KEY_PREFIX = 'user-';
// Each account's settings (just its site colour so far), in the accounts store next to
// the account. The admin has one too, though its account lives in the environment.
const SETTINGS_KEY_PREFIX = 'settings-';
const MAX_GAMES = 500; // per backlog
const MAX_ACCOUNTS = 1000;
// The one admin account (password in the environment). Only the admin sees errors and
// Gemini usage on the Stats page, and can change or delete other accounts. Games get
// genres from Gemini only for premium accounts; the admin always is one.
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
  'Racing', 'RPG', 'Shooter', 'Souls-Like', 'Sports'
];
// No longer genres. Gemini can still answer these (so it has a way to say "none of
// the above"), and a game it puts there is left without a genre and marked noGenre,
// so it isn't asked about again. Old games and typed brackets with these show none.
const REMOVED_GENRES = ['Other', 'Simulation'];
// Google has no API for remaining quota, so Gemini calls are counted here for the
// Stats page, per Pacific day because that's when Google resets daily limits.
// Kept forever, like page views: a day is only a few bytes.
const GEMINI_USAGE_KEY = 'gemini';
// Each premium account's own Gemini use, for its profile page:
// { total: { requests, tokens }, days: { 'YYYY-MM-DD': { requests, tokens } } }.
const GEMINI_USER_KEY_PREFIX = 'gemini-user-';
// The newest games added to anyone's backlog, for the Stats page:
// [{ owner, id, title, createdAt }], newest first.
const RECENT_KEY = 'recent';
const MAX_RECENT = 20;
// The admin's electricity summary from Octopus (netlify/lib/octopus.mjs), kept for a
// while so the profile page doesn't ask Octopus every visit. Smart meter readings
// arrive about once a day anyway. { at, summary }.
const ENERGY_KEY = 'energy';
const ENERGY_CACHE_MS = 30 * 60 * 1000;
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

// iat (when the session started) lets a session be told apart from a newer account
// with the same name, made after the old one was deleted. See activeSession.
function createSession(username) {
  const payload = Buffer.from(JSON.stringify({ sub: username, iat: Date.now() })).toString('base64url');
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
    return { username, isAdmin: username === ADMIN_USERNAME, iat: Number(session.iat) || 0 };
  } catch {
    return null;
  }
}

// The session, if its account still exists: a deleted account's sessions stop
// working, including for a new account later made with the same name (sessions
// from before that account was created don't count for it). Accounts made before
// createdAt was recorded have none, and their sessions keep working.
async function activeSession(request) {
  const session = getSession(request);
  if (!session || session.isAdmin) return session;
  const account = await accountsStore().get(accountKey(session.username), { type: 'json' });
  if (!account) return null;
  if (account.createdAt && session.iat < account.createdAt) return null;
  return session;
}

// Removes an account and everything kept for it: its backlog, its settings and the
// account itself. The admin account can't be deleted.
async function deleteAccount(username) {
  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const { blobs } = await store.list({ prefix: backlogPrefix(username) });
  await Promise.all(blobs.map(({ key }) => store.delete(key)));
  await statsStore().delete(geminiUserKey(username));
  await updateRecent(list => list.filter(entry => entry.owner !== username));
  const accounts = accountsStore();
  await accounts.delete(settingsKey(username));
  await accounts.delete(accountKey(username));
}

function normalizeUsername(username) {
  return username.trim().toLowerCase();
}

function validUsername(username) {
  return typeof username === 'string' && username.length > 0 && username.length <= 128;
}

// For new accounts only: no invisible or control characters (zero-width spaces and
// the like, \p{C}), and nothing that reads as the admin's name once spacing,
// punctuation and look-alike forms are taken out ("Kiwa_mari", "ｋｉｗａｍａｒｉ").
function allowedNewUsername(username) {
  if (/\p{C}/u.test(username)) return false;
  const plain = username.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return plain !== ADMIN_USERNAME;
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

// Premium is "premium": true in the account's record, set by the admin on the Users
// page. The admin always is premium. Only premium accounts get genres from Gemini.
async function isPremium(username) {
  if (username === ADMIN_USERNAME) return true;
  const account = await accountsStore().get(accountKey(username), { type: 'json' });
  return account?.premium === true;
}

function geminiUserKey(username) {
  return `${GEMINI_USER_KEY_PREFIX}${accountKey(username).slice(ACCOUNT_KEY_PREFIX.length)}`;
}

// What the pages are told about the signed-in person. color is their own site colour
// (null for the default), which the pages use as the trim colour.
async function publicUser(username) {
  const [settings, premium] = await Promise.all([
    accountsStore().get(settingsKey(username), { type: 'json' }),
    isPremium(username)
  ]);
  return {
    username: displayName(username),
    isAdmin: username === ADMIN_USERNAME,
    isPremium: premium,
    color: cleanColor(settings?.color)
  };
}

// Everything the profile page shows. Anyone can see anyone's profile.
async function readProfile(username) {
  const isAdmin = username === ADMIN_USERNAME;
  const accounts = accountsStore();
  const [account, settings, games, gemini] = await Promise.all([
    isAdmin ? null : accounts.get(accountKey(username)),
    accounts.get(settingsKey(username)),
    listGames(getStore({ name: STORE_NAME, consistency: 'strong' }), username),
    statsStore().get(geminiUserKey(username), { type: 'json' })
  ]);
  const bytes = text => (text ? Buffer.byteLength(text) : 0);
  const premium = isAdmin || JSON.parse(account || '{}').premium === true;
  const empty = { requests: 0, tokens: 0 };
  return {
    username: displayName(username),
    isAdmin,
    isPremium: premium,
    // Only premium accounts use Gemini, so only they have usage to show.
    gemini: premium ? {
      today: { ...empty, ...gemini?.days?.[pacificDay.format(new Date())] },
      total: { ...empty, ...gemini?.total }
    } : null,
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

// The username an account's key was made from (see accountKey).
function usernameFromKey(key) {
  const rest = key.slice(ACCOUNT_KEY_PREFIX.length);
  return rest.startsWith('~') ? Buffer.from(rest.slice(1), 'base64url').toString('utf8') : rest;
}

// Every account for the Users page: the admin first, then A–Z.
async function listUsers() {
  const accounts = accountsStore();
  const { blobs } = await accounts.list({ prefix: ACCOUNT_KEY_PREFIX });
  const others = await Promise.all(blobs.map(async ({ key }) => {
    const account = await accounts.get(key, { type: 'json' });
    return { username: usernameFromKey(key), isAdmin: false, isPremium: account?.premium === true };
  }));
  others.sort((first, second) => first.username.localeCompare(second.username, undefined, { numeric: true, sensitivity: 'base' }));
  return [{ username: ADMIN_DISPLAY_NAME, isAdmin: true, isPremium: true }, ...others];
}

async function listGames(store, username) {
  const { blobs } = await store.list({ prefix: backlogPrefix(username) });
  const games = await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })));
  return games.filter(Boolean).map(withoutRemovedGenre);
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
    // Replaced by the server's own time when saved (see the POST handler), so nobody
    // can date a game into the future to keep it at the top of "Recently added".
    createdAt: Date.now()
  };
}

// ---------- Genres ----------

// A game whose genre is one of REMOVED_GENRES, shown and saved without one.
function withoutRemovedGenre(game) {
  const removed = REMOVED_GENRES.some(genre => genre.toLowerCase() === game.category?.toLowerCase());
  return removed ? { ...game, category: '', noGenre: true } : game;
}

// Returns one of GAME_CATEGORIES, '' if Gemini picked one of REMOVED_GENRES (no genre),
// or null if Gemini isn't set up or doesn't answer.
// Only the game's name is sent to Google, never its note or anything else.
// Failures are logged to the Stats page errors, and the game is saved without a
// genre so the backfill can try again later.
async function categorizeGame(game, username) {
  if (!process.env.GEMINI_API_KEY) {
    await logGeminiError('GEMINI_API_KEY is not set');
    return null;
  }
  const usage = await statsStore().get(GEMINI_USAGE_KEY, { type: 'json' }).catch(() => null);
  const models = GEMINI_MODELS.filter(model =>
    !(Date.now() - (usage?.limited?.[model] || 0) < GEMINI_COOLDOWN_MS));
  // Every model is cooling down after a 429; skip quietly, the backfill retries later.
  if (!models.length) return null;

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
        await recordGeminiCall(model, response.status === 429 ? 'limited' : 'failed', 0, username);
        failures.push(`${model}: HTTP ${response.status}${detail ? ` (${detail.slice(0, 160)})` : ''}`);
        continue;
      }
      const result = await response.json();
      await recordGeminiCall(model, 'ok', result.usageMetadata?.totalTokenCount, username);
      const text = result.candidates?.[0]?.content?.parts
        ?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
      const category = (() => {
        try { return JSON.parse(text).category; } catch { return null; }
      })();
      if (GAME_CATEGORIES.includes(category)) return category;
      if (REMOVED_GENRES.includes(category)) return '';
      failures.push(`${model}: unexpected answer ${JSON.stringify(text.slice(0, 80))}`);
    } catch (error) {
      await recordGeminiCall(model, 'failed', 0, username);
      failures.push(`${model}: ${error.name === 'TimeoutError' ? `no answer within ${Math.round(timeout / 1000)}s` : error.message}`);
    }
  }
  await logGeminiError(failures.join('; '));
  return null;
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
            properties: { category: { type: 'STRING', enum: [...GAME_CATEGORIES, ...REMOVED_GENRES] } },
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
// the question, the answer and any thinking. Every call is also counted for the
// account it was made for, shown on its profile.
async function recordGeminiCall(model, outcome, tokens = 0, username = null) {
  const today = pacificDay.format(new Date());
  const used = Number.isFinite(tokens) ? tokens : 0;
  if (username) {
    try {
      await updateJson(statsStore(), geminiUserKey(username), (usage) => {
        const add = (counts) => ({ requests: (counts?.requests || 0) + 1, tokens: (counts?.tokens || 0) + used });
        return { total: add(usage?.total), days: { ...usage?.days, [today]: add(usage?.days?.[today]) } };
      });
    } catch (error) {
      console.error('Could not record Gemini usage for an account', error);
    }
  }
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

// Which account a game's key belongs to (see backlogPrefix).
function ownerFromGameKey(key) {
  if (key.startsWith(KEY_PREFIX)) return ADMIN_USERNAME;
  const match = key.match(/^user\/([^/]+)\//);
  return match ? usernameFromKey(`${ACCOUNT_KEY_PREFIX}${match[1]}`) : null;
}

// The Stats page's "Recently added", across everyone's backlogs. Kept up to date as
// games are added, renamed and removed. The first time it's asked for, it's built
// from every game there is.
async function readRecent() {
  const store = statsStore();
  const saved = await store.get(RECENT_KEY, { type: 'json' });
  if (Array.isArray(saved)) return saved;
  const games = getStore({ name: STORE_NAME, consistency: 'strong' });
  const { blobs } = await games.list();
  const all = await Promise.all(blobs.map(async ({ key }) => {
    const owner = ownerFromGameKey(key);
    const game = owner && await games.get(key, { type: 'json' });
    return game ? { owner, id: game.id, title: game.title, createdAt: game.createdAt } : null;
  }));
  const recent = all.filter(Boolean).sort((first, second) => second.createdAt - first.createdAt).slice(0, MAX_RECENT);
  await store.setJSON(RECENT_KEY, recent, { onlyIfNew: true });
  return recent;
}

// change(list) returns the new list. Best effort: a failure here never stops the
// game itself being saved or removed.
async function updateRecent(change) {
  try {
    await readRecent();
    await updateJson(statsStore(), RECENT_KEY, (list) => change(Array.isArray(list) ? list : []).slice(0, MAX_RECENT));
  } catch (error) {
    console.error('Could not update recent additions', error);
  }
}

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
    store.get(GEMINI_USAGE_KEY, { type: 'json' })
  ]);
  return {
    views: views || { totals: {}, days: {} },
    // The admin account lives in the environment, not in the store.
    accounts: blobs.length + 1,
    // Site-wide Gemini use, shown to everyone.
    gemini: {
      ...(gemini || { days: {}, lastLimitedAt: null }),
      today: pacificDay.format(new Date()),
      configured: Boolean(process.env.GEMINI_API_KEY),
      // Optional: your daily request limit from AI Studio, to show usage against it.
      dailyLimit: Number(process.env.GEMINI_DAILY_LIMIT) || null
    },
    // Errors can include details about the site's setup, so only the admin gets them.
    ...(session?.isAdmin ? { errors: errors || [] } : {})
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
          if (!allowedNewUsername(username)) {
            return respond(request, 400, { error: 'That username isn\'t allowed. Pick another.' });
          }
          const { blobs } = await accounts.list({ prefix: ACCOUNT_KEY_PREFIX });
          if (blobs.length >= MAX_ACCOUNTS) {
            return respond(request, 429, { error: 'Account registration is currently full' });
          }
          const credentials = await hashPassword(password);
          pendingRegistration = { username, key, password };
          const created = await accounts.set(key, JSON.stringify({ username, ...credentials, createdAt: Date.now() }), {
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
      const session = await activeSession(request);
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

      if (params.has('recent')) {
        const recent = await readRecent();
        return respond(request, 200, {
          recent: recent.map(({ owner, title, createdAt }) => ({ owner: displayName(owner), title, createdAt }))
        });
      }

      // ?energy: the admin's electricity use and costs, for their profile's admin panel.
      // Private: only the admin gets it. ?energy=fresh skips the saved copy.
      if (params.has('energy')) {
        if (!session?.isAdmin) return respond(request, 403, { error: 'Only the admin can see energy use' });
        if (!octopusConfigured()) {
          return respond(request, 503, {
            error: "Octopus isn't set up yet: add OCTOPUS_API_KEY, OCTOPUS_MPAN, OCTOPUS_SERIAL and OCTOPUS_ACCOUNT on Netlify"
          });
        }
        const saved = await statsStore().get(ENERGY_KEY, { type: 'json' });
        if (saved && params.get('energy') !== 'fresh' && Date.now() - saved.at < ENERGY_CACHE_MS) {
          return respond(request, 200, { ...saved.summary, updatedAt: saved.at });
        }
        try {
          const summary = await readEnergySummary();
          const at = Date.now();
          await statsStore().setJSON(ENERGY_KEY, { at, summary });
          return respond(request, 200, { ...summary, updatedAt: at });
        } catch (error) {
          console.error('Octopus request failed', error);
          return respond(request, 502, { error: `Couldn't get usage from Octopus: ${error.message}` });
        }
      }

      if (params.has('users')) {
        return respond(request, 200, { users: await listUsers() });
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
    const session = await activeSession(request);
    if (!session) return respond(request, 401, { error: 'Please sign in again' });

    // Sent by the Users page. Deletes the account with its backlog and settings.
    if (request.method === 'POST' && body?.action === 'delete-user') {
      if (!session.isAdmin) return respond(request, 403, { error: 'Only the admin can delete accounts' });
      const username = typeof body.username === 'string' ? await findAccount(body.username) : null;
      if (!username) return respond(request, 404, { error: 'There is no account with that name' });
      if (username === ADMIN_USERNAME) return respond(request, 400, { error: 'The admin account cannot be deleted' });
      await deleteAccount(username);
      return respond(request, 200, { deleted: true });
    }

    // Sent by the Users page's pen: the admin changes another account's settings.
    // premium (true/false) and color ("#rrggbb", or '' for the default) are each
    // optional. The admin is always premium. Answers with the updated profile.
    if (request.method === 'POST' && body?.action === 'update-user') {
      if (!session.isAdmin) return respond(request, 403, { error: 'Only the admin can change accounts' });
      const username = typeof body.username === 'string' ? await findAccount(body.username) : null;
      if (!username) return respond(request, 404, { error: 'There is no account with that name' });
      const color = body.color === undefined || body.color === '' ? null : cleanColor(body.color);
      if (color === null && body.color !== undefined && body.color !== '') {
        return respond(request, 400, { error: 'Invalid colour' });
      }
      if (body.premium !== undefined && typeof body.premium !== 'boolean') {
        return respond(request, 400, { error: 'Invalid premium setting' });
      }
      if (body.premium !== undefined && username !== ADMIN_USERNAME) {
        await updateJson(accountsStore(), accountKey(username), account => ({ ...account, premium: body.premium }));
      }
      if (body.color !== undefined) {
        await updateJson(accountsStore(), settingsKey(username), settings => ({ ...settings, color }));
      }
      return respond(request, 200, { profile: await readProfile(username) });
    }

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

    // Backlogs are never given genres after the fact on their own. This is sent by the
    // admin from the Users page, one game at a time and spaced out, to fill in genres
    // for games Gemini hasn't answered for yet (added before genres existed, or while
    // Gemini was down) on a premium account's backlog. The Gemini use counts for that
    // account.
    if (request.method === 'POST' && body?.action === 'categorize') {
      if (!session.isAdmin) return respond(request, 403, { error: 'Only the admin can fill in genres' });
      const owner = typeof body.username === 'string' ? await findAccount(body.username) : session.username;
      if (!owner) return respond(request, 404, { error: 'There is no account with that name' });
      if (!await isPremium(owner)) {
        return respond(request, 403, { error: 'Automatic genres need a premium account' });
      }
      if (!validId(body.id)) return respond(request, 400, { error: 'Invalid game id' });
      const key = `${backlogPrefix(owner)}${body.id}`;
      const saved = await store.getWithMetadata(key, { type: 'json' });
      const game = saved?.data && withoutRemovedGenre(saved.data);
      if (!game || game.category || game.noGenre) return respond(request, 200, { game: game || null });
      const category = await categorizeGame(game, owner);
      if (category === null) return respond(request, 200, { game }); // Gemini unavailable; try again next time.
      const categorized = category ? { ...game, category } : { ...game, noGenre: true };
      // Don't save over the game if it was edited or removed while Gemini was answering.
      const result = await store.set(key, JSON.stringify(categorized), {
        metadata: { title: game.title },
        onlyIfMatch: saved.etag
      });
      return respond(request, 200, { game: result.modified ? categorized : null });
    }

    if (request.method === 'POST') {
      const cleaned = cleanGame(body.game);
      if (!cleaned) return respond(request, 400, { error: 'Invalid game entry' });
      const game = withoutRemovedGenre(cleaned);

      const key = `${prefix}${game.id}`;
      const existing = await store.get(key, { type: 'json' });
      if (!existing) {
        const { blobs } = await store.list({ prefix });
        if (blobs.length >= MAX_GAMES) return respond(request, 413, { error: 'Backlog is full' });
      }
      // A genre typed by hand wins. Otherwise, for premium accounts only, Gemini is asked
      // once per game: once a game has a genre (or Gemini found none), edits keep that.
      const previous = existing && withoutRemovedGenre(existing);
      // An edit keeps the time the game was first added.
      if (Number.isFinite(previous?.createdAt)) game.createdAt = previous.createdAt;
      if (!game.category && !game.noGenre && previous) {
        game.category = previous.category || '';
        if (previous.noGenre) game.noGenre = true;
      }
      // Only new games: an edit never asks Gemini, even for a game without a genre.
      if (!existing && !game.category && !game.noGenre && await isPremium(session.username)) {
        const category = await categorizeGame(game, session.username);
        if (category) game.category = category;
        else if (category === '') game.noGenre = true;
      }

      await store.set(key, JSON.stringify(game), {
        metadata: { title: game.title }
      });
      // A new game goes to the top of the Stats page's "Recently added"; a renamed one
      // keeps its place under its new name.
      const owner = session.username;
      const isEntry = entry => entry.owner === owner && entry.id === game.id;
      await updateRecent(list => existing
        ? list.map(entry => isEntry(entry) ? { ...entry, title: game.title } : entry)
        : [{ owner, id: game.id, title: game.title, createdAt: game.createdAt }, ...list.filter(entry => !isEntry(entry))]);
      return respond(request, 201, { game });
    }

    if (request.method === 'DELETE') {
      if (!validId(body.id)) return respond(request, 400, { error: 'Invalid game id' });

      await store.delete(`${prefix}${body.id}`);
      await updateRecent(list => list.filter(entry => !(entry.owner === session.username && entry.id === body.id)));
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