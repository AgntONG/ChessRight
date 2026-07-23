import { Chess } from 'chess.js';
import { applyResultToUser } from './elo.js';

const MAX_CHAT_LEN = 280;
const MAX_CHAT_PER_MIN = 12;
const RECONNECT_WINDOW_MS = 60 * 1000;
const FLAG_THRESHOLD = 3;
const MAX_CLIENTS = 4;
const WS_HEARTBEAT_MS = 30 * 1000;
const MAX_TIME_CONTROLS = ['bullet', 'blitz', 'rapid', 'classical'];
const VALID_PRANK_TYPES = new Set(['flip', 'fake_lag', 'fog', 'piece_swarm', 'reverse_pawn']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function parseTimeControl(tc) {
  if (!tc) return { initial: 600000, increment: 5000, label: 'rapid' };
  if (tc.base_ms && tc.inc_ms) {
    return { initial: tc.base_ms, increment: tc.inc_ms, label: tc.label || 'custom' };
  }
  const presets = {
    bullet: { initial: 60000, increment: 0, label: 'bullet' },
    blitz: { initial: 300000, increment: 2000, label: 'blitz' },
    rapid: { initial: 600000, increment: 5000, label: 'rapid' },
    classical: { initial: 1800000, increment: 15000, label: 'classical' }
  };
  return presets[tc.label] || presets.rapid;
}

function parseMessage(raw) {
  if (typeof raw !== 'string') {
    if (raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw);
    else if (raw && raw.byteLength != null) raw = new TextDecoder().decode(raw);
    else return null;
  }
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
  return msg;
}

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.gameState = null;
    this.players = null;
    this.timeControl = null;
    this.clocks = null;
    this.lastMoveAt = null;
    this.ended = false;
    this.adminConnected = false;
    this.prankState = null;
    this.started = false;
    this.drawOfferBy = null;
    this.moveHistory = [];
    this.flagCounts = new Map();
    this.chatTimestamps = new Map();
    this.reconnectTimers = new Map();
    this.heartbeatTimer = null;
  }

  async loadState() {
    if (this.initialized) return;
    this.initialized = true;
    const stored = await this.state.storage.get('room');
    if (stored) {
      this.players = stored.players;
      this.timeControl = stored.timeControl;
      this.clocks = stored.clocks || null;
      this.gameState = stored.gameState || null;
      this.lastMoveAt = stored.lastMoveAt || null;
      this.started = !!stored.started;
      this.ended = !!stored.ended;
      this.moveHistory = stored.moveHistory || [];
      this.drawOfferBy = stored.drawOfferBy || null;
    }
  }

  async persistState() {
    await this.state.storage.put('room', {
      players: this.players,
      timeControl: this.timeControl,
      clocks: this.clocks,
      gameState: this.gameState,
      lastMoveAt: this.lastMoveAt,
      started: this.started,
      ended: this.ended,
      moveHistory: this.moveHistory,
      drawOfferBy: this.drawOfferBy
    });
  }

  broadcast(message, exceptWs = null) {
    const data = JSON.stringify(message);
    for (const [, ws] of this.sessions) {
      if (ws === exceptWs) continue;
      try { ws.send(data); } catch {}
    }
  }

  sendTo(ws, message) {
    try { ws.send(JSON.stringify(message)); } catch {}
  }

  async fetch(request) {
    await this.loadState();
    const url = new URL(request.url);

    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.players && this.started) {
        return json({ ok: true, already: true });
      }
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON', code: 'INVALID_BODY' }, 400); }
      const players = body.players;
      if (!players || !players.white || !players.black) {
        return json({ error: 'players.white and players.black required', code: 'INVALID_BODY' }, 400);
      }
      for (const color of ['white', 'black']) {
        if (typeof players[color].userId !== 'string' || typeof players[color].handle !== 'string') {
          return json({ error: `players.${color}.{userId,handle} required`, code: 'INVALID_BODY' }, 400);
        }
      }
      this.players = {
        white: { userId: players.white.userId, handle: players.white.handle, rating: typeof players.white.rating === 'number' ? players.white.rating : 1200 },
        black: { userId: players.black.userId, handle: players.black.handle, rating: typeof players.black.rating === 'number' ? players.black.rating : 1200 }
      };
      this.timeControl = parseTimeControl(body.timeControl);
      this.clocks = { w: this.timeControl.initial, b: this.timeControl.initial };
      this.gameState = null;
      this.lastMoveAt = null;
      this.started = false;
      this.ended = false;
      this.moveHistory = [];
      this.drawOfferBy = null;
      await this.persistState();
      return json({ ok: true, gameId: this.gameId() });
    }

    if (url.pathname === '/admin/state' && request.method === 'GET') {
      return json(this.snapshot());
    }

    if (url.pathname === '/admin/prank' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON', code: 'INVALID_BODY' }, 400); }
      const result = await this.applyPrank(body.prankType || body.prank, body.targetUserId, body.adminId);
      return json(result, result.error ? 400 : 200);
    }

    if (url.pathname === '/admin/end' && request.method === 'POST') {
      if (this.ended) return json({ error: 'Game already ended', code: 'GAME_ENDED' }, 409);
      let body = {};
      try { body = await request.json(); } catch {}
      await this.endGame(body.reason || 'aborted', body.winnerColor || null, 'admin');
      return json({ ended: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ error: 'Expected WebSocket', code: 'BAD_REQUEST' }, 400);
    }

    const token = url.searchParams.get('token');
    if (!token) return json({ error: 'Missing token', code: 'UNAUTHORIZED' }, 401);

    const authed = await this.verifyPlayerToken(token);
    if (!authed) return json({ error: 'Invalid token', code: 'UNAUTHORIZED' }, 401);

    const { pair, server } = new WebSocketPair();
    server.accept();

    server.serializeAttachment({ userId: authed.id, role: authed.role, authed: false });

    server.addEventListener('message', (event) => this.handleMessage(server, event).catch((e) => {
      console.error('ws message error', e);
    }));
    server.addEventListener('close', (event) => this.handleClose(server, event).catch((e) => {
      console.error('ws close error', e);
    }));
    server.addEventListener('error', () => {});

    this.sendTo(server, { type: 'auth_required' });

    return new Response(null, { status: 101, webSocket: server });
  }

  async verifyPlayerToken(token) {
    const auth = await import('./auth.js').then((m) => m.verifyWebSocketToken(token, this.env.AUTH_SECRET, this.env));
    if (!auth) return null;
    await this.loadState();
    if (auth.isAdmin) {
      return { id: auth.id, role: 'admin', handle: 'admin' };
    }
    if (!this.players) return null;
    for (const color of ['white', 'black']) {
      const p = this.players[color];
      if (p && p.userId === auth.id) return { id: auth.id, role: color, handle: auth.handle };
    }
    return null;
  }

  async handleMessage(ws, event) {
    const attachment = ws.deserializeAttachment() || {};
    const raw = event.data;
    if (!attachment.authed) {
      const first = parseMessage(raw);
      if (first && first.type === 'auth' && typeof first.token === 'string') {
        const authed = await this.verifyPlayerToken(first.token);
        if (!authed) {
          this.sendTo(ws, { type: 'error', error: 'Invalid token', code: 'UNAUTHORIZED' });
          ws.close(4001, 'Unauthorized');
          return;
        }
        attachment.authed = true;
        attachment.userId = authed.id;
        attachment.role = authed.role;
        ws.serializeAttachment(attachment);
        await this.attachSession(ws, authed);
        return;
      }
      this.sendTo(ws, { type: 'error', error: 'Authentication required first', code: 'AUTH_REQUIRED' });
      return;
    }

    const msg = parseMessage(raw);
    if (!msg) {
      this.sendTo(ws, { type: 'error', error: 'Invalid message', code: 'INVALID_MESSAGE' });
      return;
    }
    if (msg.type === 'ping') {
      this.sendTo(ws, { type: 'pong', t: Date.now() });
      return;
    }

    if (attachment.role === 'admin') {
      await this.handleAdminMessage(ws, msg);
      return;
    }

    switch (msg.type) {
      case 'move': await this.handleMove(ws, msg); break;
      case 'resign': await this.handleResign(attachment); break;
      case 'draw_offer': await this.handleDrawOffer(attachment); break;
      case 'draw_accept': await this.handleDrawAccept(attachment); break;
      case 'draw_decline': await this.handleDrawDecline(attachment); break;
      case 'chat': await this.handleChat(attachment, msg); break;
      default:
        this.sendTo(ws, { type: 'error', error: 'Unknown message type', code: 'UNKNOWN_TYPE' });
    }
  }

  async attachSession(ws, authed) {
    if (this.sessions.size >= MAX_CLIENTS) {
      this.sendTo(ws, { type: 'error', error: 'Room full', code: 'ROOM_FULL' });
      ws.close(1013, 'Room full');
      return;
    }
    if (authed.role === 'admin') {
      this.adminConnected = true;
      this.sessions.set('admin', ws);
      this.sendTo(ws, { type: 'admin_attached', state: this.snapshot() });
      return;
    }

    const color = authed.role;
    const prev = this.sessions.get(color);
    if (prev && prev.readyState === 1) {
      prev.close(4003, 'Replaced');
    }
    this.sessions.set(color, ws);

    if (this.reconnectTimers.has(color)) {
      clearTimeout(this.reconnectTimers.get(color));
      this.reconnectTimers.delete(color);
      this.broadcast({ type: 'reconnected', color }, ws);
    }

    this.sendTo(ws, {
      type: 'hello',
      you: color,
      players: this.players,
      gameState: this.gameState ? this.publicGameState() : null,
      clocks: this.clocks,
      moveHistory: this.moveHistory,
      started: this.started,
      ended: this.ended
    });

    if (this.started && !this.ended) {
      this.broadcast({ type: 'presence', color, present: true }, ws);
    }

    await this.maybeStart();
  }

  async maybeStart() {
    if (this.started || this.ended) return;
    if (!this.players) return;
    if (!this.sessions.has('white') || !this.sessions.has('black')) return;

    const chess = new Chess();
    this.gameState = { fen: chess.fen(), turn: 'w', pgn: [] };
    this.lastMoveAt = Date.now();
    this.started = true;
    this.clocks = { w: this.timeControl.initial, b: this.timeControl.initial };

    await this.persistState();
    await this.recordActive();

    this.broadcast({ type: 'game_start', gameState: this.publicGameState(), clocks: this.clocks, lastMoveAt: this.lastMoveAt });
    this.startHeartbeat();
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.tickClocks().catch(() => {}), WS_HEARTBEAT_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async tickClocks() {
    if (!this.started || this.ended || !this.gameState || !this.clocks) return;
    const color = this.gameState.turn;
    const now = Date.now();
    const elapsed = now - (this.lastMoveAt || now);
    if (elapsed <= 0) return;
    const remaining = this.clocks[color] - elapsed;
    if (remaining <= 0) {
      this.clocks[color] = 0;
      this.lastMoveAt = now;
      await this.endGame('timeout', color === 'w' ? 'b' : 'w', 'clock');
      return;
    }
    this.clocks[color] = remaining;
    this.lastMoveAt = now;
    await this.persistState();
    this.broadcast({ type: 'clock', clocks: this.clocks });
  }

  colorForAttachment(attachment) {
    return attachment.role === 'white' ? 'w' : attachment.role === 'black' ? 'b' : null;
  }

  async handleMove(ws, msg) {
    if (!this.started || this.ended || !this.gameState) {
      this.sendTo(ws, { type: 'error', error: 'Game not active', code: 'NOT_ACTIVE' });
      return;
    }
    const attachment = ws.deserializeAttachment() || {};
    const color = this.colorForAttachment(attachment);
    if (!color) {
      this.sendTo(ws, { type: 'error', error: 'Not a player', code: 'FORBIDDEN' });
      return;
    }

    await this.tickClocks();
    if (this.ended) return;

    if (this.gameState.turn !== color) {
      this.flag(ws, attachment, 'move_out_of_turn');
      this.sendTo(ws, { type: 'error', error: 'Not your turn', code: 'OUT_OF_TURN' });
      return;
    }

    if (!msg.from || !msg.to) {
      this.sendTo(ws, { type: 'error', error: 'Invalid move payload', code: 'INVALID_MOVE' });
      return;
    }

    const moveObj = { from: msg.from, to: msg.to };
    if (msg.promotion) moveObj.promotion = msg.promotion;

    const chess = new Chess(this.gameState.fen);
    let result;
    try {
      result = chess.move(moveObj);
    } catch {
      result = null;
    }
    if (!result) {
      this.flag(ws, attachment, 'illegal_move');
      this.sendTo(ws, { type: 'illegal', move: moveObj });
      return;
    }

    const now = Date.now();
    const elapsed = now - (this.lastMoveAt || now);
    const used = Math.max(0, elapsed);
    this.clocks[color] = Math.max(0, (this.clocks[color] || 0) - used + (this.timeControl.increment || 0));
    this.lastMoveAt = now;

    if (this.clocks[color] <= 0) {
      this.gameState = { fen: chess.fen(), turn: chess.turn(), pgn: chess.history() };
      this.moveHistory.push({ from: result.from, to: result.to, san: result.san, color, at: now, flags: result.flags });
      await this.endGame('timeout', color === 'w' ? 'b' : 'w', 'clock');
      return;
    }

    this.gameState = { fen: chess.fen(), turn: chess.turn(), pgn: chess.history() };
    this.moveHistory.push({ from: result.from, to: result.to, san: result.san, color, at: now, flags: result.flags });
    this.drawOfferBy = null;
    await this.persistState();
    await this.updateActive();

    this.broadcast({ type: 'move', from: result.from, to: result.to, san: result.san, color, clocks: this.clocks, fen: this.gameState.fen });

    const termination = this.checkTermination(chess);
    if (termination) {
      await this.endGame(termination.reason, termination.winner, termination.detail);
    }
  }

  checkTermination(chess) {
    if (chess.isCheckmate()) {
      const loser = chess.turn();
      return { reason: 'checkmate', winner: loser === 'w' ? 'b' : 'w', detail: 'checkmate' };
    }
    if (chess.isStalemate()) return { reason: 'stalemate', winner: null, detail: 'stalemate' };
    if (chess.isThreefoldRepetition()) return { reason: 'repetition', winner: null, detail: 'threefold' };
    if (chess.isInsufficientMaterial()) return { reason: 'insufficient', winner: null, detail: 'insufficient' };
    if (chess.isDraw()) return { reason: 'draw', winner: null, detail: 'fifty_move' };
    return null;
  }

  async handleResign(attachment) {
    if (!this.started || this.ended) return;
    const color = this.colorForAttachment(attachment);
    if (!color) return;
    await this.endGame('resign', color === 'w' ? 'b' : 'w', 'resign');
  }

  async handleDrawOffer(attachment) {
    if (!this.started || this.ended) return;
    const color = this.colorForAttachment(attachment);
    if (!color) return;
    this.drawOfferBy = color;
    await this.persistState();
    this.broadcast({ type: 'draw_offer', by: color });
  }

  async handleDrawAccept(attachment) {
    if (!this.started || this.ended) return;
    const color = this.colorForAttachment(attachment);
    if (!color) return;
    if (this.drawOfferBy && this.drawOfferBy !== color) {
      await this.endGame('agreed', null, 'draw_agreed');
    } else if (!this.drawOfferBy) {
      const ws = this.sessions.get(color === 'w' ? 'white' : 'black');
      this.sendTo(ws, { type: 'error', error: 'No pending draw offer', code: 'NO_OFFER' });
    }
  }

  async handleDrawDecline(attachment) {
    const color = this.colorForAttachment(attachment);
    if (!color) return;
    this.drawOfferBy = null;
    await this.persistState();
    this.broadcast({ type: 'draw_declined', by: color });
  }

  async handleChat(attachment, msg) {
    const text = typeof msg.text === 'string' ? msg.text.slice(0, MAX_CHAT_LEN) : '';
    if (!text) return;
    const now = Date.now();
    const key = attachment.userId;
    const recent = (this.chatTimestamps.get(key) || []).filter((t) => now - t < 60000);
    if (recent.length >= MAX_CHAT_PER_MIN) {
      const ws = this.sessions.get(attachment.role);
      this.sendTo(ws, { type: 'error', error: 'Chat rate limit', code: 'RATE_LIMIT' });
      return;
    }
    recent.push(now);
    this.chatTimestamps.set(key, recent);
    this.broadcast({ type: 'chat', from: attachment.userId, handle: attachment.handle, text, at: now });
  }

  flag(ws, attachment, reason) {
    const key = attachment.userId;
    const count = (this.flagCounts.get(key) || 0) + 1;
    this.flagCounts.set(key, count);
    console.warn(`flag ${reason} user=${key} count=${count}`);
    if (count >= FLAG_THRESHOLD) {
      this.endGame('forfeit', this.colorForAttachment(attachment) === 'w' ? 'b' : 'w', `flag:${reason}`).catch(() => {});
    }
  }

  async handleAdminMessage(ws, msg) {
    if (msg.type === 'prank') {
      const result = await this.applyPrank(msg.prankType || msg.prank, msg.targetUserId);
      this.sendTo(ws, result.error ? { type: 'error', ...result } : { type: 'prank_applied', ...result });
      return;
    }
    if (msg.type === 'end') {
      await this.endGame(msg.reason || 'aborted', msg.winnerColor || null, 'admin');
      return;
    }
    if (msg.type === 'state') {
      this.sendTo(ws, { type: 'admin_state', state: this.snapshot() });
      return;
    }
    this.sendTo(ws, { type: 'error', error: 'Unknown admin message', code: 'UNKNOWN_TYPE' });
  }

  async applyPrank(prankType, targetUserId, adminId) {
    if (!VALID_PRANK_TYPES.has(prankType)) {
      return { error: 'Invalid prank type', code: 'INVALID_PRANK' };
    }
    if (!this.players) return { error: 'Game not initialized', code: 'NO_GAME' };
    const validIds = new Set(['white', 'black'].map((c) => this.players[c] && this.players[c].userId).filter(Boolean));
    if (!validIds.has(targetUserId)) {
      return { error: 'Invalid target', code: 'INVALID_TARGET' };
    }
    const now = Date.now();
    const key = `${targetUserId}`;
    const recent = (this.prankLogByTarget?.get(key) || []).filter((t) => now - t < 5 * 60 * 1000);
    if (recent.length >= 1) {
      return { error: 'Prank rate limit (1/target/5min)', code: 'RATE_LIMIT' };
    }
    recent.push(now);
    if (!this.prankLogByTarget) this.prankLogByTarget = new Map();
    this.prankLogByTarget.set(key, recent);

    const targetColor = ['white', 'black'].find((c) => this.players[c] && this.players[c].userId === targetUserId);
    const targetWs = targetColor ? this.sessions.get(targetColor) : null;

    this.prankState = { type: prankType, targetUserId, expiresAt: now + 15000, appliedAt: now };
    if (targetWs) {
      this.sendTo(targetWs, { type: 'prank', prank: prankType, expiresAt: this.prankState.expiresAt });
    } else {
      this.broadcast({ type: 'prank_queued', prank: prankType, targetUserId });
    }

    if (this.env && this.env.DB) {
      const id = 'prk_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await this.env.DB.prepare(
        'INSERT INTO prank_log (id, admin_id, target_id, prank_type, game_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(id, adminId || 'admin', targetUserId, prankType, this.gameId(), now).run().catch(() => {});
    }
    return { applied: true, prankType, targetUserId };
  }

  gameId() {
    return this.state.id.toString();
  }

  async handleClose(ws, code, reason) {
    const attachment = ws.deserializeAttachment() || {};
    if (attachment.role === 'admin') {
      this.adminConnected = false;
      this.sessions.delete('admin');
      return;
    }
    const color = attachment.role;
    if (this.sessions.get(color) === ws) {
      this.sessions.delete(color);
    }
    if (this.ended) return;

    if (!this.started) {
      this.broadcast({ type: 'opponent_left', color });
      return;
    }

    this.broadcast({ type: 'presence', color, present: false });
    const timer = setTimeout(() => {
      if (this.ended) return;
      if (!this.sessions.has(color)) {
        this.endGame('forfeit', color === 'white' ? 'b' : 'w', 'disconnect').catch(() => {});
      }
    }, RECONNECT_WINDOW_MS);
    this.reconnectTimers.set(color, timer);
  }

  async endGame(reason, winnerColor, detail) {
    if (this.ended) return;
    this.ended = true;
    this.stopHeartbeat();
    for (const [, timer] of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers.clear();

    const endedAt = Date.now();
    const result = {
      reason,
      winner: winnerColor,
      detail,
      finalFen: this.gameState ? this.gameState.fen : null,
      moveHistory: this.moveHistory,
      clocks: this.clocks,
      endedAt
    };

    this.broadcast({ type: 'end', ...result });
    await this.persistState();
    await this.clearActive();
    await this.persistGameResult(winnerColor, reason, endedAt);

    setTimeout(() => {
      for (const [, ws] of this.sessions) {
        try { ws.close(1000, 'game ended'); } catch {}
      }
    }, 5000);
  }

  async persistGameResult(winnerColor, reason, endedAt) {
    if (!this.env || !this.env.DB || !this.players) return;
    const db = this.env.DB;
    const white = this.players.white;
    const black = this.players.black;
    const startedAt = this.startedAt || (this.lastMoveAt ? this.lastMoveAt - 1000 : endedAt);

    const whiteResult = winnerColor === 'w' ? 'win' : winnerColor === 'b' ? 'loss' : 'draw';
    const blackResult = winnerColor === 'b' ? 'win' : winnerColor === 'w' ? 'loss' : 'draw';

    const pgn = (this.gameState && Array.isArray(this.gameState.pgn)) ? this.gameState.pgn.join(' ') : '';
    const movesJson = JSON.stringify(this.moveHistory || []);
    const durationMs = Math.max(0, endedAt - startedAt);

    const insertGame = async (userId, color, result, opponent) => {
      const id = 'gme_' + Math.random().toString(36).slice(2) + Date.now().toString(36) + color;
      const hash = 'rh_' + userId + endedAt + Math.random().toString(36).slice(2);
      await db.prepare(
        `INSERT INTO games (id, user_id, opponent_kind, opponent_name, opponent_rating, color, result, ending, pgn, moves_json, accuracy, estimated_elo, buckets_json, duration_ms, started_at, ended_at, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, userId, 'human', opponent.handle, opponent.rating, color, result, reason, pgn, movesJson,
        null, null, null, durationMs, startedAt, endedAt, hash
      ).run();
    };

    try {
      await insertGame(white.userId, 'w', whiteResult, black);
      await insertGame(black.userId, 'b', blackResult, white);

      const whiteRow = await db.prepare('SELECT id, handle, rating, rating_rd, games_played, wins, losses, draws, last_game_at FROM users WHERE id = ?').bind(white.userId).first();
      const blackRow = await db.prepare('SELECT id, handle, rating, rating_rd, games_played, wins, losses, draws, last_game_at FROM users WHERE id = ?').bind(black.userId).first();
      if (whiteRow) await applyResultToUser(db, whiteRow, black.rating, whiteResult, endedAt);
      if (blackRow) await applyResultToUser(db, blackRow, white.rating, blackResult, endedAt);
    } catch (e) {
      console.error('persistGameResult error', e);
    }
  }

  publicGameState() {
    if (!this.gameState) return null;
    return { fen: this.gameState.fen, turn: this.gameState.turn, moveCount: (this.gameState.pgn || []).length };
  }

  snapshot() {
    return {
      gameId: this.gameId(),
      started: this.started,
      ended: this.ended,
      players: this.players,
      timeControl: this.timeControl,
      clocks: this.clocks,
      gameState: this.gameState,
      moveHistory: this.moveHistory,
      sessions: [...this.sessions.keys()],
      adminConnected: this.adminConnected,
      prankState: this.prankState,
      drawOfferBy: this.drawOfferBy
    };
  }

  async recordActive() {
    if (!this.env || !this.env.DB || !this.players) return;
    const now = Date.now();
    this.startedAt = now;
    const w = this.players.white;
    const b = this.players.black;
    try {
      await this.env.DB.prepare(
        'INSERT OR REPLACE INTO active_games (id, white_id, white_handle, white_rating, black_id, black_handle, black_rating, time_control, fen, started_at, last_move_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(this.gameId(), w.userId, w.handle, w.rating, b.userId, b.handle, b.rating, this.timeControl.label, this.gameState ? this.gameState.fen : null, now, now).run();
    } catch (e) {
      console.error('recordActive error', e);
    }
  }

  async updateActive() {
    if (!this.env || !this.env.DB) return;
    try {
      await this.env.DB.prepare('UPDATE active_games SET fen = ?, last_move_at = ? WHERE id = ?')
        .bind(this.gameState ? this.gameState.fen : null, Date.now(), this.gameId()).run();
    } catch {}
  }

  async clearActive() {
    if (!this.env || !this.env.DB) return;
    try {
      await this.env.DB.prepare('DELETE FROM active_games WHERE id = ?').bind(this.gameId()).run();
    } catch {}
  }
}

export async function configureRoom(players, timeControl) {
  return {
    players,
    timeControl: parseTimeControl(timeControl),
    clocks: null,
    gameState: null,
    lastMoveAt: null,
    started: false,
    ended: false,
    moveHistory: [],
    drawOfferBy: null
  };
}
