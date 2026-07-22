const POLL_TIMEOUT_MS = 25000;
const BASE_WINDOW = 50;
const WINDOW_GROWTH_PER_SEC = 8;
const WINDOW_CAP = 300;
const STALE_MS = 5 * 60 * 1000;

function ticketId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = '';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % 36];
  return 'tkt_' + out;
}

function gameId() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = '';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % 36];
  return 'gm_' + out;
}

function currentWindow(joinedAt, now) {
  const elapsed = Math.max(0, (now - joinedAt) / 1000);
  return Math.min(WINDOW_CAP, BASE_WINDOW + elapsed * WINDOW_GROWTH_PER_SEC);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

export class MatchQueue {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.queue = new Map();
    this.waiters = new Map();
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    this.initialized = true;
    const stored = await this.state.storage.get('matches');
    this.matches = stored || {};
  }

  async putMatch(ticketA, ticketB, match) {
    await this.ensureInitialized();
    this.matches[ticketA] = match;
    this.matches[ticketB] = match;
    await this.state.storage.put('matches', this.matches);
  }

  notify(ticketId) {
    const waiters = this.waiters.get(ticketId);
    if (waiters) {
      for (const resolve of waiters) resolve();
      this.waiters.delete(ticketId);
    }
  }

  async addToQueue(player) {
    await this.ensureInitialized();
    const existing = [...this.queue.values()].find((p) => p.userId === player.userId);
    if (existing) {
      return { ticketId: existing.ticketId, status: 'waiting' };
    }
    const now = Date.now();
    const tId = ticketId();
    const entry = { ticketId: tId, userId: player.userId, handle: player.handle, rating: player.rating, peerId: player.peerId, timeControl: player.timeControl, joinedAt: now };
    this.queue.set(tId, entry);
    await this.tryMatch();
    return { ticketId: tId, status: this.matches[tId] ? 'matched' : 'waiting' };
  }

  async tryMatch() {
    await this.ensureInitialized();
    const now = Date.now();
    const entries = [...this.queue.values()].filter((p) => (now - p.joinedAt) < STALE_MS);
    for (const a of entries) {
      if (!this.queue.has(a.ticketId)) continue;
      const wA = currentWindow(a.joinedAt, now);
      for (const b of entries) {
        if (a.ticketId === b.ticketId) continue;
        if (!this.queue.has(b.ticketId)) continue;
        if (a.timeControl && b.timeControl && a.timeControl !== b.timeControl) continue;
        const wB = currentWindow(b.joinedAt, now);
        const delta = Math.abs(a.rating - b.rating);
        if (delta <= wA && delta <= wB) {
          this.queue.delete(a.ticketId);
          this.queue.delete(b.ticketId);
          const gid = gameId();
          const match = {
            gameId: gid,
            createdAt: now,
            players: [
              { ticketId: a.ticketId, userId: a.userId, handle: a.handle, rating: a.rating, peerId: a.peerId, color: 'w' },
              { ticketId: b.ticketId, userId: b.userId, handle: b.handle, rating: b.rating, peerId: b.peerId, color: 'b' }
            ]
          };
          await this.putMatch(a.ticketId, b.ticketId, match);
          this.notify(a.ticketId);
          this.notify(b.ticketId);
          break;
        }
      }
    }
  }

  async removeFromQueue(ticketId) {
    await this.ensureInitialized();
    const removed = this.queue.delete(ticketId);
    this.waiters.delete(ticketId);
    return removed;
  }

  async getMatchFor(ticketId) {
    await this.ensureInitialized();
    return this.matches[ticketId] || null;
  }

  async poll(ticketId, signal) {
    await this.ensureInitialized();
    const existing = this.matches[ticketId];
    if (existing) return { status: 'matched', game: this.viewFor(existing, ticketId) };
    if (!this.queue.has(ticketId)) return { status: 'expired' };

    const waitPromise = new Promise((resolve) => {
      let resolveOnce = resolve;
      const list = this.waiters.get(ticketId) || [];
      list.push(() => resolveOnce());
      this.waiters.set(ticketId, list);
    });

    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), POLL_TIMEOUT_MS));
    const winner = await Promise.race([waitPromise.then(() => 'matched'), timeout]);
    if (signal && signal.aborted) return { status: 'expired' };

    if (winner === 'matched') {
      const match = this.matches[ticketId];
      if (match) return { status: 'matched', game: this.viewFor(match, ticketId) };
    }
    if (!this.queue.has(ticketId) && !this.matches[ticketId]) {
      return { status: 'expired' };
    }
    return { status: 'waiting' };
  }

  viewFor(match, ticketId) {
    const me = match.players.find((p) => p.ticketId === ticketId);
    const opp = match.players.find((p) => p.ticketId !== ticketId);
    return {
      gameId: match.gameId,
      createdAt: match.createdAt,
      me: { userId: me.userId, handle: me.handle, rating: me.rating, peerId: me.peerId, color: me.color },
      opponent: { userId: opp.userId, handle: opp.handle, rating: opp.rating, peerId: opp.peerId, color: opp.color }
    };
  }

  async fetch(request) {
    await this.ensureInitialized();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/queue' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON', code: 'INVALID_BODY' }, 400); }
      if (!body || !body.userId) return json({ error: 'userId required', code: 'INVALID_BODY' }, 400);
      const rating = typeof body.rating === 'number' ? body.rating : 1200;
      const result = await this.addToQueue({
        userId: body.userId,
        handle: body.handle || 'Player',
        rating,
        peerId: body.peerId || null,
        timeControl: body.timeControl || null
      });
      return json(result);
    }

    const pollMatch = path.match(/^\/poll\/([^/]+)$/);
    if (pollMatch && request.method === 'GET') {
      const tId = decodeURIComponent(pollMatch[1]);
      const result = await this.poll(tId);
      return json(result);
    }

    const leaveMatch = path.match(/^\/leave\/([^/]+)$/);
    if (leaveMatch && (request.method === 'DELETE' || request.method === 'POST')) {
      const tId = decodeURIComponent(leaveMatch[1]);
      const removed = await this.removeFromQueue(tId);
      return json({ status: removed ? 'removed' : 'not_in_queue' });
    }

    if (path === '/stats' && request.method === 'GET') {
      return json({ waiting: this.queue.size, matches: Object.keys(this.matches).length });
    }

    return json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  }
}
