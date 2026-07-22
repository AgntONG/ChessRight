const enc = new TextEncoder();
const dec = new TextDecoder();

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const NONCE_TTL_MS = 15 * 60 * 1000;
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function base64urlEncode(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function randomBase36(len) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % 36];
  return out;
}

function randomHandle() {
  const a = ['Quick','Brave','Calm','Sharp','Swift','Bold','Silent','Golden','Iron','Crimson','Azure','Neon','Cosmic','Turbo','Mega','Hyper'];
  const b = ['Knight','Rook','Bishop','Pawn','King','Queen','Castle','Gambit','Check','Mate','Blitz','Talon','Falcon','Tiger','Fox','Hawk'];
  const ra = a[Math.floor(Math.random() * a.length)];
  const rb = b[Math.floor(Math.random() * b.length)];
  return `${ra}${rb}${Math.floor(Math.random() * 90 + 10)}`;
}

async function getKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function splitToken(token) {
  if (!token || !token.startsWith('tok_')) return null;
  const rest = token.slice(4);
  const parts = rest.split('.');
  if (parts.length !== 4) return null;
  const [userId, tsStr, nonce, mac] = parts;
  const ts = parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || !userId || !nonce || !mac) return null;
  return { userId, ts, nonce, mac };
}

function signingPayload(userId, ts, nonce) {
  return `tok|${userId}|${ts}|${nonce}`;
}

async function verifyToken(token, secret, env) {
  const parsed = splitToken(token);
  if (!parsed) return null;
  const now = Date.now();
  if (now - parsed.ts > TOKEN_TTL_MS) return null;
  if (Math.abs(now - parsed.ts) > TIMESTAMP_TOLERANCE_MS + TOKEN_TTL_MS) return null;
  const key = await getKey(secret);
  const payload = signingPayload(parsed.userId, parsed.ts, parsed.nonce);
  const ok = await crypto.subtle.verify('HMAC', key, base64urlDecode(parsed.mac), enc.encode(payload));
  if (!ok) return null;
  if (!parsed.userId.startsWith('usr_')) return null;
  if (env && env.DB) {
    const consumed = await consumeNonce(env.DB, parsed.nonce, now);
    if (!consumed) return null;
  }
  return parsed.userId;
}

async function consumeNonce(db, nonce, now) {
  const expiresAt = now + NONCE_TTL_MS;
  try {
    const res = await db.prepare('INSERT INTO seen_nonces (nonce, expires_at) VALUES (?, ?)').bind(nonce, expiresAt).run();
    if (res.meta && res.meta.changes === 0) return false;
    return true;
  } catch (e) {
    return false;
  } finally {
    db.prepare('DELETE FROM seen_nonces WHERE expires_at < ?').bind(now).run().catch(() => {});
  }
}

async function issueToken(userId, secret) {
  const ts = Date.now();
  const nonce = randomBase36(12);
  const payload = signingPayload(userId, ts, nonce);
  const key = await getKey(secret);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `tok_${userId}.${ts}.${nonce}.${base64urlEncode(mac)}`;
}

async function equalConstantTime(a, b) {
  const ab = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ab.length !== bb.length) {
    const key = await crypto.subtle.importKey('raw', ab, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await crypto.subtle.sign('HMAC', key, bb);
    return false;
  }
  const key = await crypto.subtle.importKey('raw', ab, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const aH = await crypto.subtle.sign('HMAC', key, ab);
  const bKey = await crypto.subtle.importKey('raw', ab, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', bKey, aH, bb);
}

export function authMiddleware() {
  return async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return c.json({ error: 'Missing bearer token', code: 'UNAUTHORIZED' }, 401);
    }
    const userId = await verifyToken(m[1], c.env.AUTH_SECRET, c.env);
    if (!userId) {
      return c.json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' }, 401);
    }
    const row = await c.env.DB.prepare(
      'SELECT id, handle, rating, rating_rd, games_played, wins, losses, draws, is_admin, is_banned, banned_at, banned_reason FROM users WHERE id = ?'
    ).bind(userId).first();
    if (!row) {
      return c.json({ error: 'User not found', code: 'UNAUTHORIZED' }, 401);
    }
    if (row.is_banned) {
      return c.json({ error: 'Account banned', code: 'BANNED' }, 403);
    }
    c.set('user', row);
    await next();
  };
}

export function adminMiddleware() {
  return async (c, next) => {
    const provided = c.req.header('X-Admin-Token') || '';
    const expected = c.env.ADMIN_TOKEN || '';
    if (!expected) {
      return c.json({ error: 'Admin not configured', code: 'ADMIN_UNCONFIGURED' }, 503);
    }
    if (!provided) {
      return c.json({ error: 'Missing admin token', code: 'UNAUTHORIZED' }, 401);
    }
    const ok = await equalConstantTime(provided, expected);
    if (!ok) {
      return c.json({ error: 'Invalid admin token', code: 'UNAUTHORIZED' }, 401);
    }
    await next();
  };
}

export async function verifyWebSocketToken(token, secret, env) {
  if (!token) return null;
  const userId = await verifyToken(token, secret, env || null);
  if (!userId) return null;
  if (env && env.DB) {
    const row = await env.DB.prepare('SELECT id, handle, rating, is_banned, is_admin FROM users WHERE id = ?').bind(userId).first();
    if (!row || row.is_banned) return null;
    return row;
  }
  return { id: userId };
}

export function registerAuthRoutes(app) {
  app.post('/api/auth/anonymous', async (c) => {
    const secret = c.env.AUTH_SECRET;
    if (!secret) {
      return c.json({ error: 'Server missing AUTH_SECRET', code: 'MISCONFIGURED' }, 500);
    }
    const userId = `usr_${randomBase36(16)}`;
    const handle = randomHandle();
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        'INSERT INTO users (id, handle, rating, rating_rd, games_played, wins, losses, draws, created_at) VALUES (?, ?, 1200, 350, 0, 0, 0, 0, ?)'
      ).bind(userId, handle, now).run();
    } catch (e) {
      const fallback = `${randomHandle()}${randomBase36(4)}`;
      await c.env.DB.prepare(
        'INSERT INTO users (id, handle, rating, rating_rd, games_played, wins, losses, draws, created_at) VALUES (?, ?, 1200, 350, 0, 0, 0, 0, ?)'
      ).bind(userId, fallback, now).run();
    }
    const token = await issueToken(userId, secret);
    return c.json({ userId, handle, token, rating: 1200 });
  });

  app.post('/api/auth/refresh', authMiddleware(), async (c) => {
    const user = c.get('user');
    const token = await issueToken(user.id, c.env.AUTH_SECRET);
    return c.json({ token });
  });

  app.get('/api/auth/me', authMiddleware(), async (c) => {
    const u = c.get('user');
    return c.json({
      id: u.id,
      handle: u.handle,
      rating: u.rating,
      rating_rd: u.rating_rd,
      gamesPlayed: u.games_played,
      wins: u.wins,
      losses: u.losses,
      draws: u.draws,
      isAdmin: u.is_admin === 1
    });
  });
}
