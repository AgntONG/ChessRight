import { Hono } from 'hono';
import { authMiddleware, registerAuthRoutes } from './auth.js';
import { registerGameRoutes } from './games.js';
import { registerLeaderboardRoutes } from './leaderboard.js';
import { registerInviteRoutes } from './invite.js';
import { registerAdminRoutes } from './admin.js';
import { MatchQueue } from './queue.js';
import { GameRoom } from './gameroom.js';

export { MatchQueue, GameRoom };

const WS_CONN_TTL_MS = 2 * 60 * 1000;

function allowedWsOrigins(env) {
  const raw = env.ALLOWED_WS_ORIGINS || 'https://agntong.github.io';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function maxWsPerIp(env) {
  const n = parseInt(env.MAX_WS_PER_IP || '5', 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function isOriginAllowed(originHeader, env) {
  if (!originHeader) return false;
  return allowedWsOrigins(env).includes(originHeader.toLowerCase());
}

async function countActiveWsForIp(db, ip) {
  const now = Date.now();
  await db.prepare('DELETE FROM ws_connections WHERE created_at < ?').bind(now - WS_CONN_TTL_MS).run().catch(() => {});
  const row = await db.prepare('SELECT COUNT(*) as n FROM ws_connections WHERE ip = ?').bind(ip).first();
  return row ? row.n : 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const app = new Hono();

app.use('*', async (c, next) => {
  const reqOrigin = c.req.header('Origin') || '';
  const allowed = [
    'https://agntong.github.io',
    'http://localhost:8785',
    'http://localhost:8765',
    'http://localhost:8766',
    'http://localhost:8770',
    'http://127.0.0.1:8785',
  ];
  if (reqOrigin && allowed.includes(reqOrigin)) {
    c.header('Access-Control-Allow-Origin', reqOrigin);
  }
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token');
  c.header('Access-Control-Max-Age', '86400');
  if (c.req.method === 'OPTIONS') {
    if (!reqOrigin || !allowed.includes(reqOrigin)) {
      return new Response(null, { status: 204 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': reqOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Admin-Token',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  await next();
});

app.get('/', (c) => c.html('<h1>ChessRight API</h1><p>The chess server is running.</p><p>Frontend: <a href="https://agntong.github.io/ChessRight/">agontong.github.io/ChessRight</a></p>'));

app.get('/api/health', (c) => c.json({ ok: true, service: 'chessright-api', ts: Date.now() }));

registerAuthRoutes(app);
registerGameRoutes(app);
registerLeaderboardRoutes(app);
registerInviteRoutes(app);
registerAdminRoutes(app);

app.post('/api/match/queue', authMiddleware(), async (c) => {
  const user = c.get('user');
  let body = {};
  try { body = await c.req.json(); } catch {}
  const id = c.env.MATCH_QUEUE.idFromName('global');
  const stub = c.env.MATCH_QUEUE.get(id);
  const resp = await stub.fetch('https://do.local/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: user.id,
      handle: user.handle,
      rating: typeof body.rating === 'number' ? body.rating : user.rating,
      peerId: body.peerId || null,
      timeControl: body.timeControl || null
    })
  });
  return new Response(resp.body, { status: resp.status, headers: { 'content-type': 'application/json' } });
});

app.get('/api/match/poll/:ticketId', async (c) => {
  const ticketId = c.req.param('ticketId');
  const id = c.env.MATCH_QUEUE.idFromName('global');
  const stub = c.env.MATCH_QUEUE.get(id);
  const resp = await stub.fetch(`https://do.local/poll/${encodeURIComponent(ticketId)}`);
  return new Response(resp.body, { status: resp.status, headers: { 'content-type': 'application/json' } });
});

app.delete('/api/match/queue/:ticketId', authMiddleware(), async (c) => {
  const ticketId = c.req.param('ticketId');
  const id = c.env.MATCH_QUEUE.idFromName('global');
  const stub = c.env.MATCH_QUEUE.get(id);
  const resp = await stub.fetch(`https://do.local/leave/${encodeURIComponent(ticketId)}`, { method: 'DELETE' });
  return new Response(resp.body, { status: resp.status, headers: { 'content-type': 'application/json' } });
});

app.get('/api/match/stats', async (c) => {
  const id = c.env.MATCH_QUEUE.idFromName('global');
  const stub = c.env.MATCH_QUEUE.get(id);
  const resp = await stub.fetch('https://do.local/stats');
  return new Response(resp.body, { status: resp.status, headers: { 'content-type': 'application/json' } });
});

app.post('/api/game/create', authMiddleware(), async (c) => {
  const user = c.get('user');
  let body = {};
  try { body = await c.req.json(); } catch {}
  const opponent = body.opponent;
  if (!opponent || typeof opponent.userId !== 'string' || typeof opponent.handle !== 'string') {
    return json({ error: 'opponent {userId, handle, rating} required', code: 'INVALID_BODY' }, 422);
  }
  const w = { userId: user.id, handle: user.handle, rating: user.rating };
  const b = { userId: opponent.userId, handle: opponent.handle, rating: typeof opponent.rating === 'number' ? opponent.rating : 1200 };
  const gameId = body.gameId || ('gm_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  const id = c.env.GAME_ROOM.idFromName(gameId);
  const stub = c.env.GAME_ROOM.get(id);
  await stub.fetch('https://do.local/init', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ players: { white: w, black: b }, timeControl: body.timeControl || null })
  });
  return c.json({ gameId, wsUrl: `/api/game/${gameId}/ws` });
});

app.get('/api/game/:gameId/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return json({ error: 'WebSocket required', code: 'BAD_REQUEST' }, 400);
  }
  const origin = c.req.header('Origin') || '';
  if (!isOriginAllowed(origin, c.env)) {
    return json({ error: 'Origin not allowed', code: 'ORIGIN_REJECTED' }, 403);
  }

  const gameId = c.req.param('gameId');
  let doId;
  try { doId = c.env.GAME_ROOM.idFromName(gameId); }
  catch { return json({ error: 'Invalid game id', code: 'INVALID_GAME' }, 400); }

  const token = c.req.query('token');
  if (!token) return json({ error: 'Missing token', code: 'UNAUTHORIZED' }, 401);

  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Real-IP') || 'unknown';
  try {
    const count = await countActiveWsForIp(c.env.DB, ip);
    if (count >= maxWsPerIp(c.env)) {
      return json({ error: 'Too many WebSocket connections from this IP', code: 'WS_IP_CAP' }, 429);
    }
  } catch {}

  const stub = c.env.GAME_ROOM.get(doId);
  const resp = await stub.fetch(`https://do.local/ws?token=${encodeURIComponent(token)}&gameId=${encodeURIComponent(gameId)}`, {
    headers: { Upgrade: 'websocket' }
  });
  if (resp.status !== 101) {
    return new Response(resp.body, { status: resp.status, headers: { 'content-type': 'application/json' } });
  }
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      'INSERT OR IGNORE INTO ws_connections (ip, game_id, user_id, created_at) VALUES (?, ?, ?, ?)'
    ).bind(ip, gameId, token.slice(0, 64), Date.now()).run().catch(() => {})
  );
  return resp;
});

app.notFound((c) => c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL' }, 500);
});

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  }
};
