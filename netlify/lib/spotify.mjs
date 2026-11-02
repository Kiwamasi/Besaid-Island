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

import { recordCall } from './debug-log.mjs';

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const REDIRECT_URI = 'https://besaidisland.netlify.app/.netlify/functions/backlog';
const PLAYLIST_SCOPES = ['playlist-read-private', 'playlist-read-collaborative'];
const SCOPES = ['user-read-playback-state', 'user-modify-playback-state', ...PLAYLIST_SCOPES].join(' ');
const AUTH_KEY = 'spotify-auth';
const REQUEST_TIMEOUT_MS = 10000;
// An access token this close to running out is renewed rather than used.
const TOKEN_MARGIN_MS = 60 * 1000;
// Spotify takes a moment to report a command's result, so the speakers are read this long after.
const SETTLE_MS = 800;
const MAX_PLAYLISTS = 50;
const MAX_MUSIC_QUERY = 200;
const SPEAKER_ID = /^[\w-]{1,100}$/;
const PLAYLIST_URI = /^spotify:playlist:[A-Za-z0-9]{1,64}$/;
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
  const message = response.status === 429
    ? "Spotify's request limit has been reached, so try again in a little while"
    : response.status === 404 && path.startsWith('/me/player')
      ? "Spotify can't reach that speaker right now. Press Refresh, and if it's gone, play something on it from the Spotify app"
      : data?.error?.message || `Spotify answered HTTP ${response.status}`;
  throw Object.assign(new Error(message), { spotifyStatus: response.status });
}

// The smallest image that's big enough. Spotify lists images largest first, and may not
// give their sizes.
function pickImage(images) {
  const list = images || [];
  return (list.filter(image => image.width >= IMAGE_WIDTH).at(-1) || list[0])?.url || '';
}

// Every device with what it's doing. Spotify plays on one device at a time, so only the
// active one has a track.
async function readSpeakers(token) {
  const [{ devices }, player] = await Promise.all([
    spotify(token, 'GET', '/me/player/devices'),
    spotify(token, 'GET', '/me/player')
  ]);
  return devices.map(device => {
    const item = device.is_active ? player?.item : null;
    return {
      id: device.id,
      name: device.name,
      type: device.type,
      active: device.is_active,
      // Spotify refuses commands to a restricted device.
      online: !device.is_restricted,
      playing: device.is_active && Boolean(player?.is_playing),
      track: item?.name || '',
      artist: (item?.artists || []).map(artist => artist.name).join(', '),
      image: pickImage(item?.album?.images),
      volume: device.volume_percent,
      supportsVolume: device.supports_volume !== false
    };
  });
}

// The answer to ?home-suite.
export async function readSpotifySpeakers(store) {
  const connected = await connection(store);
  if (!connected) return { connected: false };
  return {
    connected: true,
    playlists: PLAYLIST_SCOPES.every(scope => connected.scope.split(' ').includes(scope)),
    speakers: await readSpeakers(connected.token)
  };
}

// The answer to ?home-suite=playlists. Kept apart from the speakers, as a list that rarely
// changes needn't be fetched again on each Refresh. Only the first page: more than
// MAX_PLAYLISTS wouldn't be much use as tiles, and the page says when there are.
export async function readSpotifyPlaylists(store) {
  const connected = await connection(store);
  if (!connected) throw invalid("Spotify isn't connected");
  const { items, total } = await spotify(connected.token, 'GET', `/me/playlists?limit=${MAX_PLAYLISTS}`);
  return {
    total,
    playlists: items.filter(Boolean).map(playlist => ({
      uri: playlist.uri,
      name: playlist.name,
      owner: playlist.owner?.display_name || '',
      // Spotify renamed tracks to items in 2026; a playlist can have neither.
      tracks: (playlist.items || playlist.tracks)?.total ?? null,
      image: pickImage(playlist.images)
    }))
  };
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

// Spotify may still report the music on the old speaker just after a move, so if it does,
// the page is told what the move did.
function movedTo(speakers, id) {
  const from = speakers.find(each => each.active && each.id !== id);
  if (!from) return speakers;
  const { playing, track, artist, image } = from;
  return speakers.map(each => {
    if (each.id === id) return { ...each, active: true, playing, track, artist, image };
    if (each === from) return { ...each, active: false, playing: false, track: '', artist: '', image: '' };
    return each;
  });
}

// Carries out { speaker, command, value } from the page (commands are listed at the top of
// js/home-suite.js) and answers with all the speakers: starting music on one stops it on
// whichever was playing.
export async function sendSpotifyCommand(store, { speaker, command, value }) {
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
    // Spotify's transfer keeps the track and the place in it, and leaves it playing or
    // paused as it was.
    await spotify(token, 'PUT', '/me/player', { device_ids: [speaker] });
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    return movedTo(await readSpeakers(token), speaker);
  } else if (command === 'music' || command === 'playlist') {
    if (command === 'playlist' && !(typeof value === 'string' && PLAYLIST_URI.test(value))) throw invalid('Invalid playlist');
    const what = command === 'music' ? await findMusic(token, value) : { context_uri: value };
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

  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  const speakers = await readSpeakers(token);
  if (playing === null) return speakers;
  return speakers.map(each => {
    if (each.id === speaker) return { ...each, playing, active: each.active || playing };
    return playing ? { ...each, playing: false } : each;
  });
}
