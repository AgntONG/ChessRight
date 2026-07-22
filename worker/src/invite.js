import { authMiddleware } from './auth.js';

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LEN = 6;
const TTL_MS = 60 * 60 * 1000;

function err(c, status, message, code) {
  return c.json({ error: message, code }, status);
}

function genCode() {
  const bytes = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function registerInviteRoutes(app) {
  app.post('/api/match/invite', authMiddleware(), async (c) => {
    const user = c.get('user');
    if (!user) return err(c, 401, 'Authentication required', 'UNAUTHORIZED');
    let body = {};
    try { body = await c.req.json(); } catch {}
    const peerId = typeof body.peerId === 'string' ? body.peerId : null;
    if (!peerId) return err(c, 422, 'peerId required', 'INVALID_BODY');
    const timeControl = typeof body.timeControl === 'string' ? body.timeControl : null;
    const now = Date.now();

    await c.env.DB.prepare('DELETE FROM invites WHERE created_at < ?').bind(now - TTL_MS).run();

    let code;
    for (let attempt = 0; attempt < 5; attempt++) {
      code = genCode();
      try {
        await c.env.DB.prepare(
          'INSERT INTO invites (code, creator_id, creator_rating, creator_peer_id, time_control, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(code, user.id, user.rating, peerId, timeControl, now).run();
        return c.json({ code, createdAt: now, expiresAt: now + TTL_MS });
      } catch (e) {
        if (!String(e && e.message || '').includes('UNIQUE')) throw e;
      }
    }
    return err(c, 500, 'Could not allocate invite code', 'CODE_COLLISION');
  });

  app.get('/api/match/invite/:code', async (c) => {
    const code = (c.req.param('code') || '').toUpperCase();
    if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return err(c, 422, 'Invalid code format', 'INVALID_CODE');
    const now = Date.now();
    await c.env.DB.prepare('DELETE FROM invites WHERE created_at < ?').bind(now - TTL_MS).run();

    const row = await c.env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
    if (!row) return err(c, 404, 'Invite not found', 'NOT_FOUND');
    if (row.taken_at) {
      return c.json({ status: 'taken', creatorPeerId: row.creator_peer_id, creatorRating: row.creator_rating });
    }
    return c.json({
      status: 'available',
      creatorPeerId: row.creator_peer_id,
      creatorRating: row.creator_rating,
      timeControl: row.time_control,
      createdAt: row.created_at,
      expiresAt: row.created_at + TTL_MS
    });
  });

  app.post('/api/match/invite/:code/claim', async (c) => {
    const code = (c.req.param('code') || '').toUpperCase();
    if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return err(c, 422, 'Invalid code format', 'INVALID_CODE');
    const now = Date.now();
    const row = await c.env.DB.prepare('SELECT * FROM invites WHERE code = ?').bind(code).first();
    if (!row) return err(c, 404, 'Invite not found', 'NOT_FOUND');
    if (row.taken_at) return err(c, 409, 'Invite already claimed', 'ALREADY_TAKEN');
    const claim = await c.env.DB.prepare(
      'UPDATE invites SET taken_at = ? WHERE code = ? AND taken_at IS NULL'
    ).bind(now, code).run();
    if (!claim.meta.changes) return err(c, 409, 'Invite already claimed', 'ALREADY_TAKEN');
    return c.json({
      status: 'taken',
      creatorPeerId: row.creator_peer_id,
      creatorRating: row.creator_rating,
      timeControl: row.time_control
    });
  });
}
