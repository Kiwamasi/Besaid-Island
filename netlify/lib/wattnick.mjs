// The Discord nickname bot ("wattnick"): sets Kiwamari's nickname in chosen Discord
// servers to the house's live electricity use from the Octopus Home Mini, like
// "Kiwamari 1.24kW ⚡" (or "Kiwamari 450W ⚡" under 1 kW).
//
// The bot is a Discord application invited to each server with Manage Nicknames. It
// never stays connected to Discord (so it shows as offline there): changing a nickname
// is one request to Discord's API with the bot's token, made by the scheduled function
// netlify/functions/wattnick.mjs once a minute. That run reads the Home Mini for the
// profile's live view first (readLiveEnergy), whether or not the bot is on, and the bot
// uses the same reading, so Octopus is asked once a minute in all.
//
// Netlify environment variables, never in the repo or the pages:
//   DISCORD_BOT_TOKEN   the bot's token (Discord Developer Portal → the app → Bot)
//   DISCORD_CLIENT_ID   optional: the application ID, for the invite link. Without it,
//                       it's read from the token, whose first part is the bot's ID.
//
// Kept in the site-stats store, set from the profile's admin panel (only the admin's):
//   SETTINGS_KEY  { enabled, nickBase, appendToName, resetName, userId, guildIds,
//                   intervalMinutes, restoreOnPause }. appendToName puts the reading on
//                   the end of the user's current name in each server instead of after
//                   nickBase (asking Discord for that name each update, one request per
//                   server). resetName is the nickname set when paused (empty: nickBase,
//                   or with appendToName the current name without the reading, or no
//                   nickname if that's empty too).
//   STATUS_KEY    { lastRunAt, watts, readAt, nicks: { guildId: nickname }, lastNickAt,
//                   restored, lastError: { at, message } | null }
//   LOG_KEY       [{ at, message }], newest first, at most MAX_LOG: settings changes,
//                 nicknames set and errors (each error once, not every minute), for the
//                 panel's log console

import { recordCall } from './debug-log.mjs';

const DISCORD_API = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10000;
const SETTINGS_KEY = 'wattnick-settings';
const STATUS_KEY = 'wattnick-status';
const LOG_KEY = 'wattnick-log';
const MAX_LOG = 50;
// Manage Nicknames, the only permission the bot asks for when invited.
const MANAGE_NICKNAMES = 1 << 27;
// Discord nicknames are at most 32 characters; " 12.34kW ⚡" takes 10 of them.
const MAX_NICK = 32;
const MAX_NICK_BASE = MAX_NICK - 10;
const MAX_GUILDS = 10;
const INTERVALS = [1, 2, 5, 10, 15, 30, 60];
// A reading older than this isn't put in a nickname: the Home Mini has probably
// stopped reporting, and the nickname is left as it is until it's back.
const STALE_MS = 10 * 60 * 1000;
const DEFAULT_SETTINGS = {
  enabled: false, nickBase: '', appendToName: false, resetName: '', userId: '', guildIds: [], intervalMinutes: 1, restoreOnPause: true
};
const SNOWFLAKE = /^\d{17,20}$/;

export function discordConfigured() {
  return Boolean(process.env.DISCORD_BOT_TOKEN);
}

function clientId() {
  if (process.env.DISCORD_CLIENT_ID) return process.env.DISCORD_CLIENT_ID.trim();
  try {
    const id = Buffer.from(process.env.DISCORD_BOT_TOKEN.split('.')[0], 'base64').toString('utf8');
    return SNOWFLAKE.test(id) ? id : null;
  } catch {
    return null;
  }
}

async function discord(method, path, body) {
  recordCall(`Discord ${method} ${path}`);
  const response = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'DiscordBot (https://kiwamasi.github.io/Besaid-Island, 1.0)'
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const wait = response.status === 429 && data?.retry_after ? ` (Discord asks to wait ${Math.ceil(data.retry_after)}s)` : '';
    throw new Error(`${data?.message || `HTTP ${response.status}`}${wait}`);
  }
  return data;
}

// "450W ⚡" under 1 kW, "1.24kW ⚡" from there.
function formatWatts(watts) {
  return `${watts < 1000 ? `${Math.round(watts)}W` : `${(watts / 1000).toFixed(2)}kW`} ⚡`;
}

// MAX_NICK_BASE leaves room for the reading. A name saved when it allowed more is
// trimmed here, rather than the reading being cut off.
function nicknameFor(base, watts) {
  return base ? `${base.slice(0, MAX_NICK_BASE).trim()} ${formatWatts(watts)}` : formatWatts(watts);
}

// A reading the bot added to the end of a name, like " 450W ⚡" or " 1.24kW ⚡".
const READING_SUFFIX = /\s*\d+(?:\.\d+)?k?W ⚡$/u;

// For appendToName: the user's name in that server as Discord has it now (their
// nickname there, else their display name), without any reading the bot added.
// display is the name Discord shows with no nickname, so the paused name can be "none".
async function currentName(guildId, userId) {
  const member = await discord('GET', `/guilds/${guildId}/members/${userId}`);
  const display = member.user?.global_name || member.user?.username || '';
  const base = (member.nick || display).replace(READING_SUFFIX, '').trim();
  return { nick: member.nick ?? null, base, display };
}

// What to set in each server: nickFor(guildId) resolves to { nick, current }, where
// current is the nickname Discord has now if it was asked (appendToName), so a change
// made in Discord itself is noticed; otherwise the last one the bot set is compared.
function readingNicks(settings, watts) {
  if (!settings.appendToName) return async () => ({ nick: nicknameFor(settings.nickBase, watts) });
  return async guildId => {
    const { nick, base } = await currentName(guildId, settings.userId);
    return { nick: nicknameFor(base, watts), current: nick };
  };
}

function pausedNicks(settings) {
  if (settings.resetName || !settings.appendToName) return async () => ({ nick: pausedNick(settings) });
  return async guildId => {
    const { nick, base, display } = await currentName(guildId, settings.userId);
    // Back to no nickname when what's left is just their display name.
    return { nick: base && base !== display ? base : null, current: nick };
  };
}

// "Set to "X" in 2 servers", naming each different nickname once.
function describeNicks(nicks) {
  const names = [...new Set(nicks)].map(nick => (nick ? `"${nick}"` : 'no nickname'));
  return `${names.join(', ')} in ${servers(nicks.length)}`;
}

async function readSettings(store) {
  return { ...DEFAULT_SETTINGS, ...((await store.get(SETTINGS_KEY, { type: 'json' })) || {}) };
}

// Checks settings sent from the profile panel; throws a message for the page if wrong.
function cleanSettings(input, current) {
  const settings = { ...current };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('Invalid on/off setting');
    settings.enabled = input.enabled;
  }
  if (input.restoreOnPause !== undefined) {
    if (typeof input.restoreOnPause !== 'boolean') throw new Error('Invalid restore setting');
    settings.restoreOnPause = input.restoreOnPause;
  }
  if (input.appendToName !== undefined) {
    if (typeof input.appendToName !== 'boolean') throw new Error('Invalid append setting');
    settings.appendToName = input.appendToName;
  }
  if (input.nickBase !== undefined) {
    if (typeof input.nickBase !== 'string') throw new Error('Invalid name');
    const nickBase = input.nickBase.replace(/\s+/g, ' ').trim();
    if (nickBase.length > MAX_NICK_BASE) throw new Error(`The name can be at most ${MAX_NICK_BASE} characters, to leave room for the reading`);
    settings.nickBase = nickBase;
  }
  if (input.resetName !== undefined) {
    if (typeof input.resetName !== 'string') throw new Error('Invalid name for when paused');
    const resetName = input.resetName.replace(/\s+/g, ' ').trim();
    if (resetName.length > MAX_NICK) throw new Error(`The name for when paused can be at most ${MAX_NICK} characters`);
    settings.resetName = resetName;
  }
  if (input.userId !== undefined) {
    const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
    if (userId && !SNOWFLAKE.test(userId)) throw new Error('A Discord user ID is 17 to 20 digits');
    settings.userId = userId;
  }
  if (input.guildIds !== undefined) {
    if (!Array.isArray(input.guildIds) || input.guildIds.length > MAX_GUILDS
      || !input.guildIds.every(id => typeof id === 'string' && SNOWFLAKE.test(id))) {
      throw new Error(`Choose at most ${MAX_GUILDS} servers`);
    }
    settings.guildIds = [...new Set(input.guildIds)];
  }
  if (input.intervalMinutes !== undefined) {
    if (!INTERVALS.includes(input.intervalMinutes)) throw new Error('Invalid update interval');
    settings.intervalMinutes = input.intervalMinutes;
  }
  if (settings.enabled && (!settings.userId || !settings.guildIds.length)) {
    throw new Error('Add your Discord user ID and choose at least one server before turning the bot on');
  }
  return settings;
}

// Sets the nickname nickFor gives (null removes it) in every chosen server where it
// differs from what's there. Records each success in next.nicks; throws the failures
// together. Returns the nicknames it changed, one for each server.
async function setNicknames(settings, nickFor, status, next) {
  next.nicks = { ...(status.nicks || {}) };
  const failures = [];
  const changed = [];
  for (const guildId of settings.guildIds) {
    try {
      const { nick, current } = await nickFor(guildId);
      const there = current !== undefined ? current : next.nicks[guildId];
      if (there === nick) {
        next.nicks[guildId] = nick;
        continue;
      }
      await discord('PATCH', `/guilds/${guildId}/members/${settings.userId}`, { nick });
      next.nicks[guildId] = nick;
      changed.push(nick);
    } catch (error) {
      failures.push(`${guildId}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Discord refused: ${failures.join('; ')}`);
  return changed;
}

// Adds lines to the log console's list, newest first. The scheduled run and a settings
// save can write at the same moment, so it only writes over the version it read.
async function appendLog(store, messages, now) {
  if (!messages.length) return;
  const entries = messages.map(message => ({ at: now, message })).reverse();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await store.getWithMetadata(LOG_KEY, { type: 'json' });
    const list = [...entries, ...(Array.isArray(existing?.data) ? existing.data : [])].slice(0, MAX_LOG);
    const result = existing
      ? await store.setJSON(LOG_KEY, list, { onlyIfMatch: existing.etag })
      : await store.setJSON(LOG_KEY, list, { onlyIfNew: true });
    if (result.modified) return;
  }
}

const servers = count => (count === 1 ? '1 server' : `${count} servers`);

// The nickname while paused: resetName, else nickBase, else none (null removes it).
function pausedNick(settings) {
  return settings.resetName || settings.nickBase || null;
}

// Puts the paused name in place where it isn't already, adding a line to log if it
// changed anything. Throws Discord's refusals, like setNicknames.
async function putNameBack(settings, status, next, log) {
  const changed = await setNicknames(settings, pausedNicks(settings), status, next);
  if (changed.length) log.push(`Paused: name set to ${describeNicks(changed)}`);
}

// Once a minute, from netlify/functions/wattnick.mjs, after it has read the Home Mini
// for the live view. live is that reading (readLiveEnergy's answer, or null with
// readError saying why); the bot only uses it, so pausing the bot never stops the
// readings. store is the site-stats store.
export async function runWattnick(store, live, readError, now = Date.now()) {
  if (!discordConfigured()) return;

  const settings = await readSettings(store);
  const status = (await store.get(STATUS_KEY, { type: 'json' })) || {};
  const next = { ...status, lastRunAt: now, lastError: null };
  const log = [];
  try {
    if (!settings.enabled) {
      // Paused: the paused name is normally put in place when Pause is pressed
      // (saveWattnickSettings); this catches it if Discord refused then.
      if (settings.restoreOnPause && !status.restored && settings.userId && settings.guildIds.length) {
        await putNameBack(settings, status, next, log);
      }
      next.restored = true;
    } else {
      next.restored = false;
      const due = !status.lastNickAt || now - status.lastNickAt >= settings.intervalMinutes * 60000 - 5000;
      if (due) {
        if (!live || live.demand === null) throw new Error(readError || 'No Home Mini reading yet');
        if (now - live.readAt > STALE_MS) throw new Error('The newest Home Mini reading is over 10 minutes old, so the nickname was left as it is');
        next.watts = live.demand;
        next.readAt = live.readAt;
        const changed = await setNicknames(settings, readingNicks(settings, live.demand), status, next);
        if (changed.length) log.push(`Nickname set to ${describeNicks(changed)}`);
        next.lastNickAt = now;
      }
    }
  } catch (error) {
    next.lastError = { at: now, message: error.message };
  }
  // Each error once when it starts (or changes), and once when it clears.
  if (next.lastError && next.lastError.message !== status.lastError?.message) log.push(`Error: ${next.lastError.message}`);
  if (!next.lastError && status.lastError) log.push('Working again');
  // Paused, the name already put back, and nothing new to say: nothing worth saving, so
  // the paused minutes don't write the store (the panel stops asking while paused too).
  if (!settings.enabled && status.restored && !next.lastError && !status.lastError && !log.length) return;
  await store.setJSON(STATUS_KEY, next);
  await appendLog(store, log, now);
}

// The panel's status, without asking Discord: polled about once a minute by the panel.
export async function readWattnickStatus(store) {
  const [settings, status, log] = await Promise.all([
    readSettings(store),
    store.get(STATUS_KEY, { type: 'json' }),
    store.get(LOG_KEY, { type: 'json' })
  ]);
  return { settings, status: status || null, log: Array.isArray(log) ? log : [] };
}

// For the profile panel: whether it's set up, the invite link, settings, status, and
// the servers the bot has been invited to (asked of Discord each time the panel opens).
export async function readWattnickPanel(store) {
  if (!discordConfigured()) return { configured: false };
  const id = clientId();
  const { settings, status, log } = await readWattnickStatus(store);
  let guilds = [];
  let guildError = null;
  try {
    guilds = (await discord('GET', '/users/@me/guilds')).map(guild => ({ id: guild.id, name: guild.name }));
  } catch (error) {
    guildError = error.message;
  }
  return {
    configured: true,
    inviteUrl: id
      ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${MANAGE_NICKNAMES}`
      : null,
    settings,
    status,
    log,
    guilds,
    guildError,
    limits: { maxNickBase: MAX_NICK_BASE, intervals: INTERVALS }
  };
}

// What changed, in words, for the log console.
function describeChanges(before, after) {
  const changes = [];
  if (after.enabled !== before.enabled) changes.push(after.enabled ? 'Bot resumed' : 'Bot paused');
  if (after.appendToName !== before.appendToName) {
    changes.push(after.appendToName ? 'Reading added to the end of your current name' : 'Reading added to the name set here');
  }
  if (after.nickBase !== before.nickBase) changes.push(after.nickBase ? `Name changed to "${after.nickBase}"` : 'Name cleared');
  if (after.resetName !== before.resetName) {
    changes.push(after.resetName ? `Name when paused changed to "${after.resetName}"` : 'Name when paused cleared');
  }
  if (after.userId !== before.userId) changes.push(after.userId ? 'Discord user ID changed' : 'Discord user ID cleared');
  if (after.guildIds.join() !== before.guildIds.join()) changes.push(`Servers changed (${servers(after.guildIds.length)} chosen)`);
  if (after.intervalMinutes !== before.intervalMinutes) {
    changes.push(`Updates every ${after.intervalMinutes === 1 ? 'minute' : `${after.intervalMinutes} minutes`}`);
  }
  if (after.restoreOnPause !== before.restoreOnPause) {
    changes.push(`Put name back when paused: ${after.restoreOnPause ? 'on' : 'off'}`);
  }
  return changes.length ? changes : ['Settings saved (nothing changed)'];
}

export async function saveWattnickSettings(store, input) {
  const before = await readSettings(store);
  const settings = cleanSettings(input || {}, before);
  await store.setJSON(SETTINGS_KEY, settings);
  const now = Date.now();
  await appendLog(store, describeChanges(before, settings), now);
  const status = (await store.get(STATUS_KEY, { type: 'json' })) || {};
  if (settings.enabled) {
    // A changed name or server list should be applied on the next run, not skipped.
    await store.setJSON(STATUS_KEY, { ...status, lastNickAt: null });
  } else if (settings.restoreOnPause && settings.userId && settings.guildIds.length) {
    // Paused (or saved while paused): set the paused name now, not at the next run.
    const next = { ...status, restored: false };
    const log = [];
    try {
      await putNameBack(settings, status, next, log);
      next.restored = true;
      if (status.lastError) log.push('Working again');
      next.lastError = null;
    } catch (error) {
      next.lastError = { at: now, message: error.message };
      log.push(`Error: ${error.message}`);
    }
    await store.setJSON(STATUS_KEY, next);
    await appendLog(store, log, now);
  }
  return settings;
}
