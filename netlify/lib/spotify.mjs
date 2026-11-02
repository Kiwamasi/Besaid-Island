// Spotify for the Home Suite page (js/home-suite.js): the Alexa speakers around the house
// are Spotify Connect devices, so they're reached through Spotify's Web API rather than
// through Amazon, which has no public API for this. Only the admin gets any of it.
//
// So far this signs in to Spotify and lists the devices it can see, to find out whether
// the speakers show up. The playback controls come once they do.
//
// Netlify environment variables, never in the repo or the pages:
//   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET   from the app in Spotify's developer dashboard
// The app's redirect URI has to be exactly REDIRECT_URI: there's no query in it, as
// backlog.mjs knows Spotify's answer by the state and code that Spotify adds.
//
// Kept in the site-stats store:
//   AUTH_KEY  { refreshToken, accessToken, expires }. The access token lasts an hour and
//             is reused until then, so most requests only ask Spotify the one question.

import { recordCall } from './debug-log.mjs';

const ACCOUNTS_URL = 'https://accounts.spotify.com';
const API_URL = 'https://api.spotify.com/v1';
const REDIRECT_URI = 'https://besaidisland.netlify.app/.netlify/functions/backlog';
const SCOPES = 'user-read-playback-state user-modify-playback-state';
const AUTH_KEY = 'spotify-auth';
const REQUEST_TIMEOUT_MS = 10000;
// An access token this close to running out is renewed rather than used.
const TOKEN_MARGIN_MS = 60 * 1000;

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
    expires: Date.now() + token.expires_in * 1000
  });
}

// A working access token, or null if Spotify isn't connected (or no longer is).
async function accessToken(store) {
  const auth = await store.get(AUTH_KEY, { type: 'json' });
  if (!auth?.refreshToken) return null;
  if (auth.accessToken && auth.expires - TOKEN_MARGIN_MS > Date.now()) return auth.accessToken;
  try {
    const token = await askForToken({ grant_type: 'refresh_token', refresh_token: auth.refreshToken });
    await store.setJSON(AUTH_KEY, {
      // Spotify only sometimes issues a new refresh token; otherwise the old one still works.
      refreshToken: token.refresh_token || auth.refreshToken,
      accessToken: token.access_token,
      expires: Date.now() + token.expires_in * 1000
    });
    return token.access_token;
  } catch (error) {
    // Access was taken away on Spotify's side, so the page goes back to offering Connect.
    if (error.code !== 'invalid_grant') throw error;
    await store.delete(AUTH_KEY);
    return null;
  }
}

async function spotify(token, path) {
  recordCall(`Spotify GET ${path}`);
  const response = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Spotify answered HTTP ${response.status}`);
  return data;
}

// The answer to ?home-suite. controls is false until the playback controls are added.
export async function readSpotifyDevices(store) {
  const token = await accessToken(store);
  if (!token) return { connected: false };
  const { devices } = await spotify(token, '/me/player/devices');
  return {
    connected: true,
    controls: false,
    speakers: devices.map(device => ({
      id: device.id,
      name: device.name,
      type: device.type,
      active: device.is_active,
      // Spotify refuses commands to a restricted device.
      online: !device.is_restricted,
      volume: device.volume_percent
    }))
  };
}
