import { Hono } from 'hono';
import { authMiddleware, registerAuthRoutes } from './auth.js';
import { registerGameRoutes } from './games.js';
import { registerLeaderboardRoutes } from './leaderboard.js';
import { registerInviteRoutes } from './invite.js';
import { MatchQueue } from './queue.js';

export { MatchQueue };

const app = new Hono();

app.use('*', async (c, next) => {
  const origin = c.env.CORS_ORIGIN || '*';
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  c.header('Access-Control-Max-Age', '86400');
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  await next();
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'chessright-api', ts: Date.now() }));

registerAuthRoutes(app);
registerGameRoutes(app);
registerLeaderboardRoutes(app);
registerInviteRoutes(app);

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
