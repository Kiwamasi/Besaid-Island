import { getStore } from '@netlify/blobs';

const STORE_NAME = 'public-game-backlog';
const KEY_PREFIX = 'game-';
const MAX_GAMES = 500;
const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function respond(statusCode, body) {
  return new Response(JSON.stringify(body), { status: statusCode, headers: HEADERS });
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

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  const store = getStore(STORE_NAME);

  try {
    if (request.method === 'GET') {
      const { blobs } = await store.list({ prefix: KEY_PREFIX });
      const games = await Promise.all(blobs.map(async ({ key }) =>
        store.get(key, { type: 'json' })
      ));
      return respond(200, { games: games.filter(Boolean) });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const game = cleanGame(body.game);
      if (!game) return respond(400, { error: 'Invalid game entry' });

      const key = `${KEY_PREFIX}${game.id}`;
      const existing = await store.get(key);
      if (!existing) {
        const { blobs } = await store.list({ prefix: KEY_PREFIX });
        if (blobs.length >= MAX_GAMES) return respond(413, { error: 'Backlog is full' });
      }

      await store.set(key, JSON.stringify(game), {
        metadata: { title: game.title }
      });
      return respond(201, { game });
    }

    if (request.method === 'DELETE') {
      const body = await request.json();
      if (!validId(body.id)) return respond(400, { error: 'Invalid game id' });

      await store.delete(`${KEY_PREFIX}${body.id}`);
      return respond(200, { deleted: true });
    }

    return respond(405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Backlog storage request failed', error);
    return respond(500, { error: 'Backlog storage is unavailable' });
  }
};