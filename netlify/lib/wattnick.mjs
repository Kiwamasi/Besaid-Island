// The Discord nickname bot ("wattnick"): sets Kiwamari's nickname in chosen Discord
// servers to the house's live electricity use from the Octopus Home Mini, like
// "Kiwamari 1.24 kW" (or "Kiwamari 450 W" under 1 kW).
//
// The bot is a Discord application invited to each server with Manage Nicknames. It
// never stays connected to Discord (so it shows as offline there): changing a nickname
// is one request to Discord's API with the bot's token, made by the scheduled function
// netlify/functions/wattnick.mjs once a minute. That run also reads the Home Mini for
// the profile's live view (readLiveEnergy), so Octopus is asked once a minute in all.
//
// Netlify environment variables, never in the repo or the pages:
//   DISCORD_BOT_TOKEN   the bot's token (Discord Developer Portal → the app → Bot)
//   DISCORD_CLIENT_ID   optional: the application ID, for the invite link. Without it,
//                       it's read from the token, whose first part is the bot's ID.
//
// Kept in the site-stats store, set from the profile's admin panel (only the admin's):
//   SETTINGS_KEY  { enabled, nickBase, userId, guildIds, intervalMinutes, restoreOnPause }
//   STATUS_KEY    { lastRunAt, watts, readAt, nicks: { guildId: nickname }, lastNickAt,
//                   restored, lastError: { at, message } | null }

import { octopusConfigured, readLiveEnergy } from './octopus.mjs';

const DISCORD_API = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 10000;
const SETTINGS_KEY = 'wattnick-settings';
const STATUS_KEY = 'wattnick-status';
// Manage Nicknames, the only permission the bot asks for when invited.
const MANAGE_NICKNAMES = 1 << 27;
// Discord nicknames are at most 32 characters; " 12.34 kW" takes 9 of them.
const MAX_NICK = 32;
const MAX_NICK_BASE = MAX_NICK - 9;
const MAX_GUILDS = 10;
const INTERVALS = [1, 2, 5, 10, 15, 30, 60];
// A reading older than this isn't put in a nickname: the Home Mini has probably
// stopped reporting, and the nickname is left as it is until it's back.
const STALE_MS = 10 * 60 * 1000;
const DEFAULT_SETTINGS = {
  enabled: false, nickBase: '', userId: '', guildIds: [], intervalMinutes: 1, restoreOnPause: true
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

// "450 W" under 1 kW, "1.24 kW" from there.
function formatWatts(watts) {
  return watts < 1000 ? `${Math.round(watts)} W` : `${(watts / 1000).toFixed(2)} kW`;
}

function nicknameFor(base, watts) {
  return (base ? `${base} ${formatWatts(watts)}` : formatWatts(watts)).slice(0, MAX_NICK);
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
  if (input.nickBase !== undefined) {
    if (typeof input.nickBase !== 'string') throw new Error('Invalid name');
    const nickBase = input.nickBase.replace(/\s+/g, ' ').trim();
    if (nickBase.length > MAX_NICK_BASE) throw new Error(`The name can be at most ${MAX_NICK_BASE} characters, to leave room for the reading`);
    settings.nickBase = nickBase;
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

// Sets the nickname (null removes it) in every chosen server where it differs from
// the last one set. Records each success in next.nicks; throws the failures together.
async function setNicknames(settings, nick, status, next) {
  next.nicks = { ...(status.nicks || {}) };
  const failures = [];
  for (const guildId of settings.guildIds) {
    if (next.nicks[guildId] === nick) continue;
    try {
      await discord('PATCH', `/guilds/${guildId}/members/${settings.userId}`, { nick });
      next.nicks[guildId] = nick;
    } catch (error) {
      failures.push(`${guildId}: ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Discord refused: ${failures.join('; ')}`);
}

// Once a minute, from netlify/functions/wattnick.mjs. store is the site-stats store.
export async function runWattnick(store, now = Date.now()) {
  // The Home Mini reading, saved for the profile's live view whether or not the bot is on.
  let live = null;
  let readError = null;
  if (octopusConfigured()) {
    try {
      live = await readLiveEnergy(store, now);
    } catch (error) {
      readError = error.message;
    }
  } else {
    readError = "Octopus isn't set up on Netlify";
  }
  if (!discordConfigured()) return;

  const settings = await readSettings(store);
  const status = (await store.get(STATUS_KEY, { type: 'json' })) || {};
  const next = { ...status, lastRunAt: now, lastError: null };
  try {
    if (!settings.enabled) {
      // Paused: put the plain name back once (or remove the nickname if there's none).
      if (settings.restoreOnPause && !status.restored && settings.userId && settings.guildIds.length) {
        await setNicknames(settings, settings.nickBase || null, status, next);
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
        await setNicknames(settings, nicknameFor(settings.nickBase, live.demand), status, next);
        next.lastNickAt = now;
      }
    }
  } catch (error) {
    next.lastError = { at: now, message: error.message };
  }
  await store.setJSON(STATUS_KEY, next);
}

// For the profile panel: whether it's set up, the invite link, settings, status, and
// the servers the bot has been invited to (asked of Discord each time the panel opens).
export async function readWattnickPanel(store) {
  if (!discordConfigured()) return { configured: false };
  const id = clientId();
  const [settings, status] = await Promise.all([
    readSettings(store),
    store.get(STATUS_KEY, { type: 'json' })
  ]);
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
    status: status || null,
    guilds,
    guildError,
    limits: { maxNickBase: MAX_NICK_BASE, intervals: INTERVALS }
  };
}

export async function saveWattnickSettings(store, input) {
  const settings = cleanSettings(input || {}, await readSettings(store));
  await store.setJSON(SETTINGS_KEY, settings);
  // A changed name or server list should be applied on the next run, not skipped.
  if (settings.enabled) {
    const status = (await store.get(STATUS_KEY, { type: 'json' })) || {};
    await store.setJSON(STATUS_KEY, { ...status, lastNickAt: null });
  }
  return settings;
}
