import { applyResultToUser } from './elo.js';
import { authMiddleware } from './auth.js';

const VALID_RESULT = /^(win|loss|draw)$/;
const VALID_COLOR = /^(w|b)$/;
const VALID_OPP_KIND = /^(bot|human)$/;

function err(c, status, message, code) {
  return c.json({ error: message, code }, status);
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % 36];
  return 'gme_' + out;
}

function mapGameRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    opponent: { kind: row.opponent_kind, name: row.opponent_name, rating: row.opponent_rating },
    color: row.color,
    result: row.result,
    ending: row.ending,
    pgn: row.pgn,
    moves: JSON.parse(row.moves_json || '[]'),
    accuracy: row.accuracy,
    estimatedElo: row.estimated_elo,
    buckets: row.buckets_json ? JSON.parse(row.buckets_json) : null,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    hash: row.hash,
    createdAt: row.created_at
  };
}

export function registerGameRoutes(app) {
  app.post('/api/games', authMiddleware(), async (c) => {
    const user = c.get('user');
    let body;
    try { body = await c.req.json(); }
    catch { return err(c, 422, 'Invalid JSON body', 'INVALID_BODY'); }
    if (!body || typeof body !== 'object') return err(c, 422, 'Body must be an object', 'INVALID_BODY');

    const pgn = typeof body.pgn === 'string' ? body.pgn : '';
    const moves = Array.isArray(body.moves) ? body.moves : null;
    if (!moves) return err(c, 422, "Missing 'moves' array", 'INVALID_BODY');

    const opponent = body.opponent || {};
    const opponentKind = opponent.kind;
    const opponentName = opponent.name;
    if (!VALID_OPP_KIND.test(opponentKind || '')) return err(c, 422, "opponent.kind must be 'bot' or 'human'", 'INVALID_BODY');
    if (typeof opponentName !== 'string' || !opponentName.trim()) return err(c, 422, 'opponent.name required', 'INVALID_BODY');
    const opponentRating = typeof opponent.rating === 'number' ? opponent.rating : null;

    const color = body.color;
    const result = body.result;
    const ending = typeof body.ending === 'string' ? body.ending : 'normal';
    if (!VALID_COLOR.test(color || '')) return err(c, 422, "color must be 'w' or 'b'", 'INVALID_BODY');
    if (!VALID_RESULT.test(result || '')) return err(c, 422, "result must be 'win'|'loss'|'draw'", 'INVALID_BODY');

    const accuracy = typeof body.accuracy === 'number' ? body.accuracy : null;
    const estimatedElo = typeof body.estimatedElo === 'number' ? body.estimatedElo : null;
    const buckets = body.buckets ? JSON.stringify(body.buckets) : null;
    const durationMs = typeof body.durationMs === 'number' ? body.durationMs : (typeof body.duration_ms === 'number' ? body.duration_ms : null);
    const startedAt = typeof body.startedAt === 'number' ? body.startedAt : (typeof body.started_at === 'number' ? body.started_at : null);
    const endedAt = typeof body.endedAt === 'number' ? body.endedAt : (typeof body.ended_at === 'number' ? body.ended_at : Date.now());

    const hash = await sha256Hex(JSON.stringify({ userId: user.id, moves, pgn, opponentKind, opponentName, color }));
    const existing = await c.env.DB.prepare('SELECT * FROM games WHERE user_id = ? AND hash = ?').bind(user.id, hash).first();
    if (existing) {
      return c.json({ id: existing.id, duplicate: true, game: mapGameRow(existing) }, 200);
    }

    const id = randomId();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO games (id, user_id, opponent_kind, opponent_name, opponent_rating, color, result, ending, pgn, moves_json, accuracy, estimated_elo, buckets_json, duration_ms, started_at, ended_at, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, user.id, opponentKind, opponentName, opponentRating, color, result, ending, pgn,
      JSON.stringify(moves), accuracy, estimatedElo, buckets, durationMs,
      startedAt || endedAt, endedAt, hash
    ).run();

    if (opponentKind === 'bot') {
      const updated = await applyResultToUser(c.env.DB, user, opponentRating, result, now);
      c.set('user', updated);
    }

    const row = await c.env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
    return c.json({ id, game: mapGameRow(row) }, 201);
  });

  app.get('/api/games/stats', authMiddleware(), async (c) => {
    const user = c.get('user');
    const stats = await c.env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN result='win' THEN 1 ELSE 0 END) as wins,
         SUM(CASE WHEN result='loss' THEN 1 ELSE 0 END) as losses,
         SUM(CASE WHEN result='draw' THEN 1 ELSE 0 END) as draws,
         AVG(accuracy) as avg_accuracy,
         AVG(estimated_elo) as avg_estimated_elo,
         MAX(ended_at) as last_game_at
       FROM games WHERE user_id = ?`
    ).bind(user.id).first();
    return c.json({
      gamesPlayed: stats?.total || 0,
      wins: stats?.wins || 0,
      losses: stats?.losses || 0,
      draws: stats?.draws || 0,
      avgAccuracy: stats?.avg_accuracy != null ? Number(stats.avg_accuracy) : null,
      avgEstimatedElo: stats?.avg_estimated_elo != null ? Number(stats.avg_estimated_elo) : null,
      lastGameAt: stats?.last_game_at || null
    });
  });

  app.get('/api/games/:id', authMiddleware(), async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT * FROM games WHERE id = ?').bind(id).first();
    if (!row) return err(c, 404, 'Game not found', 'NOT_FOUND');
    if (row.user_id !== user.id) return err(c, 403, 'Not allowed to view this game', 'FORBIDDEN');
    return c.json(mapGameRow(row));
  });

  app.get('/api/games', authMiddleware(), async (c) => {
    const user = c.get('user');
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '20', 10) || 20, 1), 100);
    const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
    const result = await c.env.DB.prepare(
      'SELECT * FROM games WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).bind(user.id, limit, offset).all();
    return c.json({
      games: (result.results || []).map(mapGameRow),
      limit, offset
    });
  });
}
