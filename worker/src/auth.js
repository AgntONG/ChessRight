const enc = new TextEncoder();
const dec = new TextDecoder();

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

async function signUserId(userId, secret) {
  const key = await getKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(userId));
  return base64urlEncode(sig);
}

async function verifyToken(token, secret) {
  if (!token || !token.startsWith('tok_')) return null;
  const rest = token.slice(4);
  const dot = rest.lastIndexOf('.');
  if (dot < 1) return null;
  const userId = rest.slice(0, dot);
  const mac = rest.slice(dot + 1);
  const key = await getKey(secret);
  const ok = await crypto.subtle.verify('HMAC', key, base64urlDecode(mac), enc.encode(userId));
  if (!userId.startsWith('usr_')) return null;
  return ok ? userId : null;
}

async function issueToken(userId, secret) {
  const mac = await signUserId(userId, secret);
  return `tok_${userId}.${mac}`;
}

export function authMiddleware() {
  return async (c, next) => {
    const header = c.req.header('Authorization') || '';
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return c.json({ error: 'Missing bearer token', code: 'UNAUTHORIZED' }, 401);
    }
    const userId = await verifyToken(m[1], c.env.AUTH_SECRET);
    if (!userId) {
      return c.json({ error: 'Invalid or expired token', code: 'UNAUTHORIZED' }, 401);
    }
    const row = await c.env.DB.prepare('SELECT id, handle, rating, rating_rd, games_played, wins, losses, draws FROM users WHERE id = ?').bind(userId).first();
    if (!row) {
      return c.json({ error: 'User not found', code: 'UNAUTHORIZED' }, 401);
    }
    c.set('user', row);
    await next();
  };
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
      draws: u.draws
    });
  });
}
