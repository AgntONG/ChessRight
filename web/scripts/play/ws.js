const RECONNECT_MAX_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2000;
const PING_INTERVAL_MS = 10000;
const PING_TIMEOUT_MS = 30000;
const CONNECT_TIMEOUT_MS = 15000;
const GAME_START_TIMEOUT_MS = 20000;

export class GameSocket {
  constructor({
    serverUrl,
    gameId,
    token,
    userId,
    onMove,
    onClock,
    onGameOver,
    onDrawOffer,
    onPrank,
    onDisconnect,
    onReconnect,
    onStatus,
    onError,
  } = {}) {
    if (!serverUrl) throw new Error('serverUrl is required');
    if (!gameId) throw new Error('gameId is required');
    if (!token) throw new Error('token is required');

    this.serverUrl = serverUrl.replace(/\/+$/, '');
    this.gameId = gameId;
    this.token = token;
    this.userId = userId || null;

    this.onMove = typeof onMove === 'function' ? onMove : () => {};
    this.onClock = typeof onClock === 'function' ? onClock : () => {};
    this.onGameOver = typeof onGameOver === 'function' ? onGameOver : () => {};
    this.onDrawOffer = typeof onDrawOffer === 'function' ? onDrawOffer : () => {};
    this.onPrank = typeof onPrank === 'function' ? onPrank : () => {};
    this.onDisconnect = typeof onDisconnect === 'function' ? onDisconnect : () => {};
    this.onReconnect = typeof onReconnect === 'function' ? onReconnect : () => {};
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};

    this.ws = null;
    this._closedIntentionally = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pongTimer = null;
    this._connectPromise = null;
    this._gameStarted = false;
    this._connectTimeoutTimer = null;
    this._gameStartTimeoutTimer = null;
    this._lastError = null;
  }

  _emitStatus(status) {
    try { this.onStatus(status); } catch (_) {}
  }

  _emitError(err) {
    this._lastError = err;
    try { this.onError(err); } catch (_) {}
  }

  _buildUrl() {
    const base = this.serverUrl;
    const path = base + '/api/game/' + encodeURIComponent(this.gameId) + '/ws';
    const u = new URL(path, window.location.href);
    u.searchParams.set('token', this.token);
    if (this.userId) u.searchParams.set('uid', this.userId);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    return u.href;
  }

  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._closedIntentionally = false;
    this._emitStatus('connecting');
    this._connectPromise = this._openSocket().then(() => {
      this._connectPromise = null;
    }).catch((err) => {
      this._connectPromise = null;
      throw err;
    });
    return this._connectPromise;
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      let ws;
      const url = this._buildUrl();
      try {
        ws = new WebSocket(url);
      } catch (err) {
        const e = new Error('Failed to open WebSocket: ' + (err && err.message || err));
        this._emitError(e);
        this._emitStatus('error');
        reject(e);
        return;
      }
      this.ws = ws;

      this._connectTimeoutTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          try { ws.close(); } catch (_) {}
          const e = new Error('WebSocket connect timed out');
          this._emitError(e);
          this._emitStatus('error');
          reject(e);
        }
      }, CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        if (this._connectTimeoutTimer) {
          clearTimeout(this._connectTimeoutTimer);
          this._connectTimeoutTimer = null;
        }
        this._reconnectAttempts = 0;
        try {
          ws.send(JSON.stringify({ type: 'hello', userId: this.userId }));
        } catch (_) {}
        this._startPing();
        this._armGameStartTimeout();
        resolve();
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev));

      ws.addEventListener('close', (ev) => {
        this._onClose(ev);
        if (!this._gameStarted && !this._closedIntentionally) {
          reject(new Error('WebSocket closed before game_start (code ' + (ev && ev.code) + ')'));
        }
      });

      ws.addEventListener('error', () => {
        if (!this._gameStarted && !this._closedIntentionally) {
          const e = new Error('WebSocket error during connect');
          this._emitError(e);
          this._emitStatus('error');
          try { ws.close(); } catch (_) {}
        }
      });
    });
  }

  _armGameStartTimeout() {
    if (this._gameStartTimeoutTimer) return;
    this._gameStartTimeoutTimer = setTimeout(() => {
      if (this._gameStarted) return;
      this._gameStartTimeoutTimer = null;
      const e = new Error('Timed out waiting for game_start');
      this._emitError(e);
      this._emitStatus('error');
      try { if (this.ws) this.ws.close(); } catch (_) {}
    }, GAME_START_TIMEOUT_MS);
  }

  _clearGameStartTimeout() {
    if (this._gameStartTimeoutTimer) {
      clearTimeout(this._gameStartTimeoutTimer);
      this._gameStartTimeoutTimer = null;
    }
  }

  _onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '{}');
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'game_start': {
        this._gameStarted = true;
        this._clearGameStartTimeout();
        this._emitStatus('connected');
        break;
      }
      case 'game_resume': {
        this._gameStarted = true;
        this._clearGameStartTimeout();
        this._emitStatus('connected');
        if (msg.fen) {
          try { this.onMove({ fen: msg.fen, resume: true }); } catch (_) {}
        }
        if (msg.clock) {
          try { this.onClock(msg.clock); } catch (_) {}
        }
        break;
      }
      case 'move': {
        try {
          this.onMove({
            from: msg.from,
            to: msg.to,
            promotion: msg.promotion,
            san: msg.san,
            clock: msg.clock,
          });
        } catch (_) {}
        if (msg.clock) {
          try { this.onClock(msg.clock); } catch (_) {}
        }
        break;
      }
      case 'move_rejected': {
        try {
          this.onMove({
            rejected: true,
            from: msg.from,
            to: msg.to,
            reason: msg.reason,
          });
        } catch (_) {}
        break;
      }
      case 'clock': {
        try { this.onClock(msg.clock || { w: msg.w, b: msg.b }); } catch (_) {}
        break;
      }
      case 'game_over': {
        try {
          this.onGameOver({
            result: msg.result,
            ending: msg.ending,
            ratingDelta: msg.ratingDelta,
            fen: msg.fen,
          });
        } catch (_) {}
        break;
      }
      case 'draw_offer': {
        try { this.onDrawOffer(); } catch (_) {}
        break;
      }
      case 'prank': {
        try { this.onPrank(msg.prankType || msg.prank); } catch (_) {}
        break;
      }
      case 'opponent_disconnected': {
        try {
          this.onDisconnect({
            reconnectIn: msg.reconnectIn,
            permanent: !!msg.permanent,
          });
        } catch (_) {}
        break;
      }
      case 'opponent_reconnected': {
        try { this.onReconnect(); } catch (_) {}
        break;
      }
      case 'chat': {
        break;
      }
      case 'pong': {
        this._onPong();
        break;
      }
      case 'error': {
        const e = new Error(msg.message || 'Server error');
        this._emitError(e);
        break;
      }
      default:
        break;
    }
  }

  _onClose(ev) {
    this._stopPing();
    if (this._connectTimeoutTimer) {
      clearTimeout(this._connectTimeoutTimer);
      this._connectTimeoutTimer = null;
    }
    this._clearGameStartTimeout();
    this.ws = null;

    if (this._closedIntentionally) {
      this._emitStatus('closed');
      return;
    }

    this._emitStatus('reconnecting');
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      const e = new Error('Gave up reconnecting after ' + RECONNECT_MAX_ATTEMPTS + ' attempts');
      this._emitError(e);
      this._emitStatus('error');
      return;
    }
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closedIntentionally) return;
      this._reconnect().catch((err) => {
        this._emitError(err);
        this._emitStatus('error');
      });
    }, RECONNECT_DELAY_MS);
  }

  async _reconnect() {
    this._emitStatus('connecting');
    await this._openSocket();
    if (this._gameStarted) {
      try { this.onReconnect(); } catch (_) {}
    }
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping', t: Date.now() });
      if (this._pongTimer) clearTimeout(this._pongTimer);
      this._pongTimer = setTimeout(() => {
        try { if (this.ws) this.ws.close(); } catch (_) {}
      }, PING_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  _onPong() {
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this._emitError(new Error('WebSocket send failed: ' + (err && err.message || err)));
      return false;
    }
  }

  sendMove(from, to, promotion) {
    return this._send({ type: 'move', from, to, promotion: promotion || null });
  }

  sendResign() {
    return this._send({ type: 'resign' });
  }

  sendDrawOffer() {
    return this._send({ type: 'draw_offer' });
  }

  sendDrawAccept() {
    return this._send({ type: 'draw_accept' });
  }

  sendDrawDecline() {
    return this._send({ type: 'draw_decline' });
  }

  close() {
    this._closedIntentionally = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopPing();
    this._clearGameStartTimeout();
    if (this._connectTimeoutTimer) {
      clearTimeout(this._connectTimeoutTimer);
      this._connectTimeoutTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify({ type: 'goodbye' })); } catch (_) {}
    }
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this._emitStatus('closed');
  }

  get isOpen() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  get isGameStarted() {
    return this._gameStarted;
  }
}

export default { GameSocket };
