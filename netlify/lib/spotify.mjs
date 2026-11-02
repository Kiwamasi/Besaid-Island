// Spotify for the Home Suite page (js/home-suite.js): the Alexa speakers around the house
// are Spotify Connect devices, so they're reached through Spotify's Web API rather than
// through Amazon, which has no public API for this. Only the admin gets any of it.
//
// Netlify environment variables, never in the repo or the pages:
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET   from the app in Spotify's developer dashboard
// The app's redirect URI has to be exactly REDIRECT_URI: there's no query in it, as
// backlog.mjs knows Spotify's answer by the state and code that Spotify adds.
//
// Kept in the site-stats store:
//   AUTH_KEY  { refreshToken, accessToken, expires, scope }. The access token lasts an
//             hour and is reused until then. scope is what the admin agreed to: a sign-in
//             from before a permission was added lacks it, and has to be done again.
//   SPEAKERS_KEY  { name: { id, lastSeen } }: speakers Spotify has listed. An Echo drops off
//             Spotify's list when it goes to sleep (after about 10 minutes quiet) or after
//             a failed command, so the page shows these as asleep instead of losing them.

import { recordCall } from './debug-log.mjs';

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const REDIRECT_URI = 'https://besaidisland.netlify.app/.netlify/functions/backlog';
const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', ...PLAYLIST_SCOPES].join(' ');
const AUTH_KEY = 'spotify-auth';
const SPEAKERS_KEY = 'spotify-speakers';
const DAY_MS = 24 * 60 * 60 * 1000;
// A speaker not seen for this long has probably gone for good.
const FORGET_SPEAKER_MS = 30 * DAY_MS;
// How long to give a speaker between one way of moving the music failing and the next.
const RETRY_MS = 1500;
// Devices that are probably just closed when they're gone, so they aren't kept as asleep.
const NOT_REMEMBERED = ['Computer', 'Smartphone', 'Tablet'];
// After music is sent to a sleeping speaker, how often and how many times to look for it.
const WAKE_CHECK_MS = 2000;
const WAKE_CHECKS = 3;
const REQUEST_TIMEOUT_MS = 10000;
// An access token this close to running out is renewed rather than used.
const TOKEN_MARGIN_MS = 60 * 1000;
// Spotify takes a moment to report a command's result, so the speakers are read this long after.
const SETTLE_MS = 800;
const MAX_PLAYLISTS = 50;
const MAX_MUSIC_QUERY = 200;
const SPEAKER_ID = /^[\w-]{1,100}$/;
const PLAYLIST_URI = /^spotify:playlist:[A-Za-z0-9]{1,64}$/;
const TRACK_URI = /^spotify:(track|episode):[A-Za-z0-9]{1,64}$/;
// Spotify's largest page of a playlist's songs.
const TRACKS_PAGE = 50;
// Thumbnails are shown about this wide, so a bigger image would be wasted.
const IMAGE_WIDTH = 150;

export function spotifyConfigured() {
  return Boolean(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET);
}

// Where to send the admin to approve access. state comes back with Spotify's answer.
export function spotifyAuthUrl(state) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state
  });
  return `${ACCOUNTS_URL}/authorize?${query}`;
}

// A request that can't work as sent. backlog.mjs answers these as the page's mistake
// rather than Spotify's failure.
function invalid(message) {
  return Object.assign(new Error(message), { invalidRequest: true });
}

async function askForToken(fields) {
  recordCall(`Spotify POST /api/token (${fields.grant_type})`);
  const credentials = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error_description || data?.error || `Spotify answered HTTP ${response.status}`);
    error.code = data?.error;
    throw error;
  }
  return data;
}

// Swaps the code from Spotify's answer for the tokens, and saves them.
export async function connectSpotify(store, code) {
  const token = await askForToken({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
  await store.setJSON(AUTH_KEY, {
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expires: Date.now() + token.expires_in * 1000,
    scope: token.scope || ''
  });
}

// { token, scope }, or null if Spotify isn't connected (or no longer is).
async function connection(store) {
  const auth = await store.get(AUTH_KEY, { type: 'json' });
  if (!auth?.refreshToken) return null;
  if (auth.accessToken && auth.expires - TOKEN_MARGIN_MS > Date.now()) {
    return { token: auth.accessToken, scope: auth.scope || '' };
  }
  try {
    const token = await askForToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    const scope = token.scope || auth.scope || '';
    await store.setJSON(AUTH_KEY, {
      // Spotify only sometimes issues a new refresh token; otherwise the old one still works.
      refreshToken: token.refresh_token || auth.refreshToken,
      accessToken: token.access_token,
      expires: Date.now() + token.expires_in * 1000,
      scope
    });
    return { token: token.access_token, scope };
  } catch (error) {
    // Access was taken away on Spotify's side, so the page goes back to offering Connect.
    if (error.code !== 'invalid_grant') throw error;
    await store.delete(AUTH_KEY);
    return null;
  }
}

async function spotify(token, method, path, body) {
  recordCall(`Spotify ${method} ${path}`);
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  // Commands answer with nothing or with something that isn't JSON, as does asking what's
  // playing when nothing is.
  const data = await response.json().catch(() => null);
  if (response.ok) return data;
  // A command Spotify couldn't pass on to a speaker comes back as a 404 or a bare "Server
  // error", most often because an Echo is asleep.
  const unreachable = method !== 'GET' && path.startsWith('/me/player') && (response.status === 404 || response.status >= 500);
  const message = response.status === 429
    ? "Spotify's request limit has been reached, so try again in a little while"
    : unreachable
      ? `Spotify couldn't reach that speaker (error ${response.status}${data?.error?.message ? `: ${data.error.message}` : ''}). It's probably asleep: say "Alexa, connect to Spotify" near it, then press Refresh.`
      : data?.error?.message || `Spotify answered HTTP ${response.status}`;
  throw Object.assign(new Error(message), { spotifyStatus: response.status });
}

// The smallest image that's big enough. Spotify lists images largest first, and may not
// give their sizes.
function pickImage(images) {
  const list = images || [];
  return (list.filter(image => image.width >= IMAGE_WIDTH).at(-1) || list[0])?.url || '';
}

// The parts of a speaker's answer that say what it's playing. Nothing, for no player.
function nowPlaying(player) {
  const item = player?.item;
  return {
    playing: Boolean(player?.is_playing),
    track: item?.name || '',
    trackUri: item?.uri || '',
    artist: (item?.artists || []).map(artist => artist.name).join(', '),
    image: pickImage(item?.album?.images)
  };
}

// Notes the speakers Spotify lists now, and answers with all it has listed lately. Not
// phones or computers (NOT_REMEMBERED). It's saved only if something changed, and a
// speaker's last sighting only once a day.
async function rememberSpeakers(store, devices) {
  const known = (await store.get(SPEAKERS_KEY, { type: 'json' })) || {};
  const now = Date.now();
  let changed = false;
  for (const { id, name, type } of devices) {
    if (NOT_REMEMBERED.includes(type) || !id) continue;
    if (known[name]?.id === id && known[name].type === type && now - known[name].lastSeen < DAY_MS) continue;
    known[name] = { id, type, lastSeen: now };
    changed = true;
  }
  for (const [name, { lastSeen }] of Object.entries(known)) {
    if (now - lastSeen < FORGET_SPEAKER_MS) continue;
    delete known[name];
    changed = true;
  }
  if (changed) await store.setJSON(SPEAKERS_KEY, known);
  return known;
}

// Every device with what it's doing, and the speakers that are asleep, in name order so
// a card doesn't jump about as its speaker comes and goes. Spotify plays on one device at
// a time, so only the active one has a track. What's playing is left out if Spotify can't
// say, which has been seen just after music moves to an Echo: the speakers still show.
async function readSpeakers(store, token) {
  const [{ devices }, player] = await Promise.all([
    spotify(token, 'GET', '/me/player/devices'),
    spotify(token, 'GET', '/me/player').catch(error => {
      console.error('Spotify playback state failed', error);
      return null;
    })
  ]);
  const known = await rememberSpeakers(store, devices);
  const speakers = devices.map(device => ({
    id: device.id,
    name: device.name,
    type: device.type,
    active: device.is_active,
    // Spotify refuses commands to a restricted device.
    online: !device.is_restricted,
    asleep: false,
    ...nowPlaying(device.is_active ? player : null),
    volume: device.volume_percent,
    supportsVolume: device.supports_volume !== false
  }));
  const listed = new Set(devices.map(device => device.name));
  for (const [name, { id, type }] of Object.entries(known)) {
    if (listed.has(name)) continue;
    speakers.push({
      id, name, type: type || 'Speaker', active: false, online: true, asleep: true, ...nowPlaying(null), volume: null, supportsVolume: false
    });
  }
  return speakers.sort((first, second) => first.name.localeCompare(second.name));
}

// The answer to ?home-suite.
export async function readSpotifySpeakers(store) {
  const connected = await connection(store);
  if (!connected) return { connected: false };
  return {
    connected: true,
    playlists: PLAYLIST_SCOPES.every(scope => connected.scope.split(' ').includes(scope)),
    speakers: await readSpeakers(store, connected.token)
  };
}

// The answer to ?home-suite=playlists. Kept apart from the speakers, as a list that rarely
// changes needn't be fetched again on each Refresh. Only the first page: more than
// MAX_PLAYLISTS wouldn't be much use as tiles, and the page says when there are.
export async function readSpotifyPlaylists(store) {
  const connected = await connection(store);
  if (!connected) throw invalid("Spotify isn't connected");
  const [{ items, total }, me] = await Promise.all([
    spotify(connected.token, 'GET', `/me/playlists?limit=${MAX_PLAYLISTS}`),
    // Only for telling owned playlists from followed ones, so the list still shows without it.
    spotify(connected.token, 'GET', '/me').catch(error => {
      console.error('Spotify profile failed', error);
      return null;
    })
  ]);
  return {
    total,
    playlists: items.filter(Boolean).map(playlist => ({
      uri: playlist.uri,
      name: playlist.name,
      owner: playlist.owner?.display_name || '',
      owned: me?.id ? playlist.owner?.id === me.id : null,
      // Spotify renamed tracks to items in 2026; a playlist can have neither.
      tracks: (playlist.items || playlist.tracks)?.total ?? null,
      image: pickImage(playlist.images)
    }))
  };
}

// The answer to ?home-suite=tracks: one page of a playlist's songs. Spotify only lists them
// for playlists the admin owns or collaborates on and answers 403 for the rest, which can
// still be played, so that's not an error here.
export async function readSpotifyPlaylistTracks(store, uri, offset) {
  if (typeof uri !== 'string' || !PLAYLIST_URI.test(uri)) throw invalid('Invalid playlist');
  if (!Number.isInteger(offset) || offset < 0) throw invalid('Invalid offset');
  const connected = await connection(store);
  if (!connected) throw invalid("Spotify isn't connected");
  let page;
  try {
    page = await spotify(connected.token, 'GET', `/playlists/${uri.split(':')[2]}/items?limit=${TRACKS_PAGE}&offset=${offset}`);
  } catch (error) {
    if (error.spotifyStatus !== 403) throw error;
    return { restricted: true, total: null, nextOffset: null, tracks: [] };
  }
  const tracks = page.items
    // A song since removed from Spotify can leave an empty entry.
    .filter(entry => entry?.item || entry?.track)
    .map(entry => {
      const item = entry.item || entry.track;
      return {
        uri: item.uri || '',
        name: item.name || 'Unknown',
        // A playlist can hold podcast episodes, which have a show instead of artists.
        artist: (item.artists || []).map(artist => artist.name).join(', ') || item.show?.name || '',
        album: item.album?.name || '',
        duration: item.duration_ms,
        added: entry.added_at || '',
        playable: !entry.is_local && !item.is_local && TRACK_URI.test(item.uri || '')
      };
    });
  return { restricted: false, total: page.total, nextOffset: page.next ? offset + TRACKS_PAGE : null, tracks };
}

// What to start for a music search: the best match's album from that track, so the music
// carries on afterwards rather than stopping after one song.
async function findMusic(token, query) {
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_MUSIC_QUERY) throw invalid('Type what to play');
  const search = new URLSearchParams({ q: query.trim(), type: 'track', limit: '1' });
  const { tracks } = await spotify(token, 'GET', `/search?${search}`);
  const track = tracks?.items?.[0];
  if (!track) throw invalid(`Spotify found nothing for "${query.trim()}"`);
  return { context_uri: track.album.uri, offset: { uri: track.uri } };
}

// What to send to start what's playing again on another speaker, at the same place. A
// position in the context works only for albums and playlists: anything else (liked
// songs, say) continues from the song alone.
function resumeHere({ context, item, progress_ms: position }) {
  const inContext = ['album', 'playlist'].includes(context?.type);
  return {
    ...(inContext ? { context_uri: context.uri, offset: { uri: item.uri } } : { uris: [item.uri] }),
    position_ms: position || 0
  };
}

// Moves the music to a speaker, keeping the place in the song, and answers with what was
// playing. Spotify's transfer is the obvious call, but an Echo often answers it with a
// bare 500, and a failed one can knock the Echo off Spotify's list altogether. So music
// that's playing is started on the new speaker directly, and transfer is the fallback.
// Paused music goes straight to transfer, as starting it would make a noise.
async function moveMusic(token, speaker) {
  const player = await spotify(token, 'GET', '/me/player').catch(() => null);
  if (player?.is_playing && player.item?.uri) {
    try {
      await spotify(token, 'PUT', `/me/player/play?device_id=${encodeURIComponent(speaker)}`, resumeHere(player));
      return player;
    } catch (error) {
      if (error.spotifyStatus === 429) throw error;
      console.error('Spotify play on the new speaker failed, trying transfer', error);
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }
  await spotify(token, 'PUT', '/me/player', { device_ids: [speaker] });
  return player;
}

// Spotify can accept music for a sleeping speaker and then not show it waking. The page
// mustn't call that playing, so it's told Spotify took the command and nothing more.
function markUnconfirmed(speakers, id) {
  return speakers.map(each => (each.id === id ? { ...each, unconfirmed: true } : each));
}

// The speakers after a command, giving a sleeping speaker it was sent to time to wake.
async function readAfterCommand(store, token, id) {
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  let speakers = await readSpeakers(store, token);
  for (let check = 0; check < WAKE_CHECKS && speakers.find(each => each.id === id)?.asleep; check++) {
    await new Promise(resolve => setTimeout(resolve, WAKE_CHECK_MS));
    speakers = await readSpeakers(store, token);
  }
  return speakers;
}

// Spotify may still report the music on the old speaker just after a move, or may not say
// at all, so the page is told what the move did.
function movedTo(speakers, id, player) {
  if (!player) return speakers;
  if (speakers.find(each => each.id === id)?.asleep) return markUnconfirmed(speakers, id);
  return speakers.map(each => {
    if (each.id === id) return { ...each, ...nowPlaying(player), active: true, asleep: false };
    return each.active ? { ...each, ...nowPlaying(null), active: false } : each;
  });
}

// Carries out { speaker, command, value } from the page (commands are listed at the top of
// js/home-suite.js) and answers with all the speakers: starting music on one stops it on
// whichever was playing.
export async function sendSpotifyCommand(store, { speaker, command, value, track }) {
  if (typeof speaker !== 'string' || !SPEAKER_ID.test(speaker)) throw invalid('Invalid speaker');
  const connected = await connection(store);
  if (!connected) throw invalid("Spotify isn't connected");
  const { token } = connected;
  const device = encodeURIComponent(speaker);
  // Spotify may still report the old state after the wait, so what a command that worked
  // did to the speaker's playing is taken from the command.
  let playing = null;

  if (command === 'play') {
    await spotify(token, 'PUT', `/me/player/play?device_id=${device}`);
    playing = true;
  } else if (command === 'move') {
    const player = await moveMusic(token, speaker);
    return movedTo(await readAfterCommand(store, token, speaker), speaker, player);
  } else if (command === 'music' || command === 'playlist') {
    if (command === 'playlist' && !(typeof value === 'string' && PLAYLIST_URI.test(value))) throw invalid('Invalid playlist');
    if (command === 'playlist' && track !== undefined && !(typeof track === 'string' && TRACK_URI.test(track))) throw invalid('Invalid song');
    const what = command === 'music'
      ? await findMusic(token, value)
      : { context_uri: value, ...(track ? { offset: { uri: track } } : {}) };
    await spotify(token, 'PUT', `/me/player/play?device_id=${device}`, what);
    playing = true;
  } else if (command === 'pause' || command === 'stop') {
    // Spotify answers 403 when it's already paused, which is what was asked for anyway.
    await spotify(token, 'PUT', `/me/player/pause?device_id=${device}`).catch(error => {
      if (error.spotifyStatus !== 403) throw error;
    });
    playing = false;
  } else if (command === 'next' || command === 'previous') {
    await spotify(token, 'POST', `/me/player/${command}?device_id=${device}`);
  } else if (command === 'volume') {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw invalid('Invalid volume');
    await spotify(token, 'PUT', `/me/player/volume?volume_percent=${value}&device_id=${device}`);
  } else {
    throw invalid('Invalid command');
  }

  const speakers = await readAfterCommand(store, token, speaker);
  if (playing === null) return speakers;
  if (speakers.find(each => each.id === speaker)?.asleep) return markUnconfirmed(speakers, speaker);
  return speakers.map(each => {
    if (each.id === speaker) return { ...each, playing, active: each.active || playing };
    return playing ? { ...each, ...nowPlaying(null), active: false } : each;
  });
}
