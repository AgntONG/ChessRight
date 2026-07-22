import { adminMiddleware } from './auth.js';

const HANDLE_RE = /^[A-Za-z0-9_]{2,24}$/;
const PRANK_TYPES = new Set(['flip', 'fake_lag', 'fog', 'piece_swarm', 'reverse_pawn']);

function err(c, status, message, code) {
  return c.json({ error: message, code }, status);
}

function clientIp(c) {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Real-IP') || 'unknown';
}

async function audit(db, adminId, action, targetId, gameId, detail, ip) {
  const id = 'aud_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    await db.prepare(
      'INSERT INTO admin_audit (id, admin_id, action, target_id, game_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, adminId, action, targetId || null, gameId || null, detail || null, ip, Date.now()).run();
  } catch (e) {
    console.error('audit insert error', e);
  }
}

function resolveAdminId(c) {
  return c.req.header('X-Admin-Actor') || 'admin';
}

export function registerAdminRoutes(app) {
  app.get('/api/admin/auto-auth', async (c) => {
    const ip = clientIp(c);
    const allowedIps = (c.env.ADMIN_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowedIps.includes(ip)) {
      return c.json({ authorized: false }, 403);
    }
    const token = c.env.ADMIN_TOKEN;
    if (!token) {
      return c.json({ error: 'ADMIN_TOKEN not configured', code: 'MISCONFIG' }, 500);
    }
    return c.json({ authorized: true, token });
  });

  app.get('/api/admin/games', adminMiddleware(), async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    const result = await c.env.DB.prepare(
      'SELECT id, white_id, white_handle, white_rating, black_id, black_handle, black_rating, time_control, fen, started_at, last_move_at FROM active_games ORDER BY started_at DESC LIMIT ?'
    ).bind(limit).all();
    return c.json({ games: result.results || [] });
  });

  app.get('/api/admin/games/:id', adminMiddleware(), async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT * FROM active_games WHERE id = ?').bind(id).first();
    if (row) return c.json({ active: true, game: row });
    const stub = c.env.GAME_ROOM.get(c.env.GAME_ROOM.idFromString(id));
    try {
      const resp = await stub.fetch('https://do.local/admin/state');
      if (resp.ok) {
        const data = await resp.json();
        return c.json({ active: false, game: data });
      }
    } catch {}
    return err(c, 404, 'Game not found', 'NOT_FOUND');
  });

  app.post('/api/admin/games/:id/prank', adminMiddleware(), async (c) => {
    const gameId = c.req.param('id');
    let body;
    try { body = await c.req.json(); } catch { return err(c, 422, 'Invalid JSON body', 'INVALID_BODY'); }
    const prank = body.prank || body.prankType;
    const targetUserId = body.targetUserId;
    if (!prank || !PRANK_TYPES.has(prank)) return err(c, 422, 'Invalid prank type', 'INVALID_PRANK');
    if (typeof targetUserId !== 'string' || !targetUserId.startsWith('usr_')) return err(c, 422, 'Invalid targetUserId', 'INVALID_TARGET');

    const now = Date.now();
    const recent = await c.env.DB.prepare(
      'SELECT created_at FROM prank_log WHERE target_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1'
    ).bind(targetUserId, now - 5 * 60 * 1000).all();
    if ((recent.results || []).length > 0) {
      return err(c, 429, 'Prank rate limit (1/target/5min)', 'RATE_LIMIT');
    }

    let stub;
    try { stub = c.env.GAME_ROOM.get(c.env.GAME_ROOM.idFromString(gameId)); }
    catch { return err(c, 400, 'Invalid game id', 'INVALID_GAME'); }

    const adminId = resolveAdminId(c);
    const resp = await stub.fetch('https://do.local/admin/prank', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prankType: prank, targetUserId, adminId })
    });
    const data = await resp.json();
    if (!resp.ok) return c.json(data, resp.status);

    await audit(c.env.DB, adminId, 'prank', targetUserId, gameId, prank, clientIp(c));
    return c.json(data);
  });

  app.post('/api/admin/games/:id/end', adminMiddleware(), async (c) => {
    const gameId = c.req.param('id');
    let body = {};
    try { body = await c.req.json(); } catch {}
    let stub;
    try { stub = c.env.GAME_ROOM.get(c.env.GAME_ROOM.idFromString(gameId)); }
    catch { return err(c, 400, 'Invalid game id', 'INVALID_GAME'); }
    const resp = await stub.fetch('https://do.local/admin/end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: body.reason || 'aborted', winnerColor: body.winnerColor || null })
    });
    const data = await resp.json();
    const adminId = resolveAdminId(c);
    await audit(c.env.DB, adminId, 'end_game', null, gameId, body.reason || 'aborted', clientIp(c));
    return c.json(data, resp.status);
  });

  app.get('/api/admin/users', adminMiddleware(), async (c) => {
    const q = (c.req.query('q') || '').trim();
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    let result;
    if (q) {
      const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`;
      result = await c.env.DB.prepare(
        "SELECT id, handle, rating, games_played, is_admin, is_banned, banned_at, created_at FROM users WHERE handle LIKE ? ESCAPE '\\' ORDER BY rating DESC LIMIT ?"
      ).bind(like, limit).all();
    } else {
      result = await c.env.DB.prepare(
        'SELECT id, handle, rating, games_played, is_admin, is_banned, banned_at, created_at FROM users ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all();
    }
    return c.json({ users: result.results || [] });
  });

  app.get('/api/admin/users/:id', adminMiddleware(), async (c) => {
    const id = c.req.param('id');
    const row = await c.env.DB.prepare(
      'SELECT id, handle, rating, rating_rd, games_played, wins, losses, draws, is_admin, is_banned, banned_at, banned_reason, created_at, last_game_at FROM users WHERE id = ?'
    ).bind(id).first();
    if (!row) return err(c, 404, 'User not found', 'NOT_FOUND');
    return c.json(row);
  });

  app.post('/api/admin/users/:id/ban', adminMiddleware(), async (c) => {
    const id = c.req.param('id');
    let body = {};
    try { body = await c.req.json(); } catch {}
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 280) : null;
    const now = Date.now();
    const res = await c.env.DB.prepare(
      'UPDATE users SET is_banned = 1, banned_at = ?, banned_reason = ? WHERE id = ?'
    ).bind(now, reason, id).run();
    if (!res.meta.changes) return err(c, 404, 'User not found', 'NOT_FOUND');
    const adminId = resolveAdminId(c);
    await audit(c.env.DB, adminId, 'ban', id, null, reason, clientIp(c));
    return c.json({ id, banned: true });
  });

  app.post('/api/admin/users/:id/unban', adminMiddleware(), async (c) => {
    const id = c.req.param('id');
    const res = await c.env.DB.prepare(
      'UPDATE users SET is_banned = 0, banned_at = NULL, banned_reason = NULL WHERE id = ?'
    ).bind(id).run();
    if (!res.meta.changes) return err(c, 404, 'User not found', 'NOT_FOUND');
    const adminId = resolveAdminId(c);
    await audit(c.env.DB, adminId, 'unban', id, null, null, clientIp(c));
    return c.json({ id, banned: false });
  });

  app.post('/api/admin/users/:id/rating', adminMiddleware(), async (c) => {
    const id = c.req.param('id');
    let body;
    try { body = await c.req.json(); } catch { return err(c, 422, 'Invalid JSON body', 'INVALID_BODY'); }
    const rating = typeof body.rating === 'number' ? Math.round(body.rating) : null;
    if (rating == null || rating < 100 || rating > 4000) return err(c, 422, 'rating must be 100..4000', 'INVALID_RATING');
    const res = await c.env.DB.prepare('UPDATE users SET rating = ? WHERE id = ?').bind(rating, id).run();
    if (!res.meta.changes) return err(c, 404, 'User not found', 'NOT_FOUND');
    const adminId = resolveAdminId(c);
    await audit(c.env.DB, adminId, 'rating_adjust', id, null, String(rating), clientIp(c));
    return c.json({ id, rating });
  });

  app.get('/api/admin/stats', adminMiddleware(), async (c) => {
    const queueId = c.env.MATCH_QUEUE.idFromName('global');
    const queueStub = c.env.MATCH_QUEUE.get(queueId);
    let queueDepth = 0;
    try {
      const resp = await queueStub.fetch('https://do.local/stats');
      if (resp.ok) {
        const data = await resp.json();
        queueDepth = data.waiting || 0;
      }
    } catch {}
    const [activeGames, totalUsers, bannedUsers] = await Promise.all([
      c.env.DB.prepare('SELECT COUNT(*) as n FROM active_games').first(),
      c.env.DB.prepare('SELECT COUNT(*) as n FROM users').first(),
      c.env.DB.prepare('SELECT COUNT(*) as n FROM users WHERE is_banned = 1').first()
    ]);
    return c.json({
      queueDepth,
      activeGames: activeGames?.n || 0,
      totalUsers: totalUsers?.n || 0,
      bannedUsers: bannedUsers?.n || 0
    });
  });

  app.get('/api/admin/audit', adminMiddleware(), async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 200);
    const targetId = c.req.query('targetId');
    let result;
    if (targetId) {
      result = await c.env.DB.prepare(
        'SELECT * FROM admin_audit WHERE target_id = ? ORDER BY created_at DESC LIMIT ?'
      ).bind(targetId, limit).all();
    } else {
      result = await c.env.DB.prepare(
        'SELECT * FROM admin_audit ORDER BY created_at DESC LIMIT ?'
      ).bind(limit).all();
    }
    return c.json({ entries: result.results || [] });
  });
}
