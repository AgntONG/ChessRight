import Peer from 'https://esm.sh/peerjs@1.5.4?bundle';

const DEFAULT_API_BASE = '/api';
const DEFAULT_TIMECONTROL = '10+5';
const QUEUE_TIMEOUT_MS = 120000;
const PEER_READY_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 15000;
const LATENCY_INTERVAL_MS = 5000;
const PEER_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function generatePeerId() {
  if (
    typeof crypto !== 'undefined' &&
    crypto.getRandomValues &&
    typeof Uint8Array !== 'undefined'
  ) {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let out = 'peer_';
    for (let i = 0; i < bytes.length; i++) {
      out += PEER_ID_ALPHABET[bytes[i] % PEER_ID_ALPHABET.length];
    }
    return out;
  }
  return 'peer_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export class QueueError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'QueueError';
    this.status = status;
    this.body = body;
  }
}

export class PeerError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'PeerError';
    this.code = code;
  }
}

export class ConnectionError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'ConnectionError';
    this.reason = reason;
  }
}

async function readErrorBody(res) {
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
  } catch (_) {
    return null;
  }
}

async function throwIfNotOk(res, defaultMessage) {
  if (res.ok) return;
  const body = await readErrorBody(res);
  const message =
    (body && typeof body === 'object' && (body.error || body.message)) ||
    (typeof body === 'string' && body) ||
    `${defaultMessage} (HTTP ${res.status})`;
  throw new QueueError(message, { status: res.status, body });
}

export class MatchClient {
  constructor({ apiBase, token, userId, rating } = {}) {
    this.apiBase = (apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
    this.token = token || null;
    this.userId = userId || null;
    this.rating = typeof rating === 'number' ? rating : null;
    this._currentTicketId = null;
    this._aborted = false;
  }

  _headers(extra = {}) {
    const h = { Accept: 'application/json', ...extra };
    if (this.token) h['Authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async _request(method, path, { payload, signal, allowEmpty = false } = {}) {
    const init = {
      method,
      headers: this._headers(
        payload !== undefined ? { 'Content-Type': 'application/json' } : {}
      ),
      signal,
    };
    if (payload !== undefined) init.body = JSON.stringify(payload);

    let res;
    try {
      res = await fetch(`${this.apiBase}${path}`, init);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new QueueError(`network error during ${method} ${path}: ${err.message}`, {
        cause: err,
      });
    }
    await throwIfNotOk(res, `request failed: ${method} ${path}`);
    if (allowEmpty) {
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    }
    return res.json();
  }

  _postJson(path, payload, opts) {
    return this._request('POST', path, { payload, ...opts });
  }

  _getJson(path, opts) {
    return this._request('GET', path, opts);
  }

  _delete(path, opts) {
    return this._request('DELETE', path, { allowEmpty: true, ...opts });
  }

  _normalizeMatchGame(serverView, fallbackHandle) {
    if (!serverView) return null;
    const me = serverView.me || {};
    const opp = serverView.opponent || {};
    const myColor = me.color || null;
    return {
      gameId: serverView.gameId,
      myColor,
      timeControl: serverView.timeControl || null,
      me: {
        userId: me.userId || null,
        handle: me.handle || fallbackHandle || null,
        rating: typeof me.rating === 'number' ? me.rating : null,
        peerId: me.peerId || null,
        color: myColor,
      },
      opponent: {
        userId: opp.userId || null,
        handle: opp.handle || null,
        rating: typeof opp.rating === 'number' ? opp.rating : null,
        peerId: opp.peerId || null,
        color: opp.color || null,
      },
    };
  }

  async findMatch({ timeControl = DEFAULT_TIMECONTROL, onStatus, signal } = {}) {
    const status = typeof onStatus === 'function' ? onStatus : () => {};

    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const myPeerId = generatePeerId();
    const queuePayload = {
      peerId: myPeerId,
      rating: this.rating,
      timeControl,
      ...(this.userId ? { userId: this.userId } : {}),
    };

    let queueRes;
    try {
      queueRes = await this._postJson('/match/queue', queuePayload, { signal });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      status('error', { error: err });
      throw err instanceof QueueError
        ? err
        : new QueueError(`failed to join queue: ${err.message}`, { cause: err });
    }

    const ticketId = queueRes.ticketId;
    if (!ticketId) {
      throw new QueueError('server returned no ticketId', { body: queueRes });
    }
    this._currentTicketId = ticketId;

    if (queueRes.status === 'matched' && queueRes.game) {
      const game = this._normalizeMatchGame(queueRes.game);
      if (game) {
        this._currentTicketId = null;
        status('queued', { ticketId, myPeerId });
        status('matched', game);
        return game;
      }
    }

    status('queued', { ticketId, myPeerId });

    const startTime = Date.now();
    const localAbort = new AbortController();
    const onExternalAbort = () => {
      this._aborted = true;
      localAbort.abort();
    };
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const pollTimer = setInterval(() => {
      if (Date.now() - startTime >= QUEUE_TIMEOUT_MS) localAbort.abort();
    }, 1000);

    try {
      while (Date.now() - startTime < QUEUE_TIMEOUT_MS) {
        if (this._aborted || (signal && signal.aborted)) {
          await this._safeLeave(ticketId);
          throw new DOMException('Aborted', 'AbortError');
        }

        let data;
        try {
          data = await this._getJson(
            `/match/poll/${encodeURIComponent(ticketId)}`,
            { signal: localAbort.signal }
          );
        } catch (err) {
          if (err && err.name === 'AbortError') {
            if (this._aborted || (signal && signal.aborted)) {
              await this._safeLeave(ticketId);
              throw new DOMException('Aborted', 'AbortError');
            }
            break;
          }
          status('error', { error: err });
          throw err instanceof QueueError
            ? err
            : new QueueError(`polling failed: ${err.message}`, { cause: err });
        }

        if (!data || data.status === 'expired') {
          throw new QueueError('ticket expired or removed from queue', {
            body: data,
          });
        }

        if (data.status === 'matched' && data.game) {
          const game = this._normalizeMatchGame(data.game);
          if (game) {
            this._currentTicketId = null;
            status('matched', game);
            return game;
          }
        }

        status('searching', { waited: Date.now() - startTime });
      }

      status('timeout');
      await this._safeLeave(ticketId);
      throw new QueueError('queue timeout');
    } finally {
      clearInterval(pollTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      this._aborted = false;
    }
  }

  async _safeLeave(ticketId) {
    if (!ticketId) return;
    try {
      await this._delete(`/match/queue/${encodeURIComponent(ticketId)}`);
    } catch (_) {
      // best-effort; network may be gone
    }
  }

  async leaveQueue(ticketId) {
    const id = ticketId || this._currentTicketId;
    if (!id) return;
    this._currentTicketId = null;
    await this._safeLeave(id);
  }

  async createInvite({ timeControl = DEFAULT_TIMECONTROL } = {}) {
    const myPeerId = generatePeerId();
    const res = await this._postJson('/match/invite', {
      peerId: myPeerId,
      rating: this.rating,
      timeControl,
      ...(this.userId ? { userId: this.userId } : {}),
    });
    if (!res || !res.code) {
      throw new QueueError('invite response missing code', { body: res });
    }
    return {
      code: res.code,
      myPeerId,
      createdAt: res.createdAt || null,
      expiresAt: res.expiresAt || null,
    };
  }

  async joinInvite(code) {
    if (!code || typeof code !== 'string') {
      throw new QueueError('invite code is required');
    }
    const normalizedCode = code.trim().toUpperCase();
    const myPeerId = generatePeerId();

    const creatorView = await this._getJson(
      `/match/invite/${encodeURIComponent(normalizedCode)}`
    );

    if (creatorView && creatorView.status === 'taken') {
      return this._buildInviteGame({
        creatorPeerId: creatorView.creatorPeerId,
        creatorRating: creatorView.creatorRating,
        timeControl: creatorView.timeControl,
        myPeerId,
      });
    }

    const claimRes = await this._postJson(
      `/match/invite/${encodeURIComponent(normalizedCode)}/claim`
    );

    if (!claimRes || claimRes.status !== 'taken' || !claimRes.creatorPeerId) {
      throw new QueueError('invite claim failed or already taken', {
        body: claimRes,
      });
    }

    return this._buildInviteGame({
      creatorPeerId: claimRes.creatorPeerId,
      creatorRating: claimRes.creatorRating,
      timeControl: claimRes.timeControl,
      myPeerId,
    });
  }

  _buildInviteGame({ creatorPeerId, creatorRating, timeControl, myPeerId }) {
    const opponentPeerId = String(creatorPeerId);
    const myColor = myPeerId < opponentPeerId ? 'w' : 'b';
    const gameId = `inv_${(myPeerId < opponentPeerId ? myPeerId : opponentPeerId)}_${(myPeerId > opponentPeerId ? myPeerId : opponentPeerId)}`;
    return {
      gameId,
      myColor,
      timeControl,
      me: {
        userId: this.userId,
        handle: null,
        rating: this.rating,
        peerId: myPeerId,
        color: myColor,
      },
      opponent: {
        userId: null,
        handle: null,
        rating: typeof creatorRating === 'number' ? creatorRating : null,
        peerId: opponentPeerId,
        color: myColor === 'w' ? 'b' : 'w',
      },
    };
  }
}

export class PeerConnection {
  constructor({
    myPeerId,
    role,
    onMessage,
    onDisconnect,
    onError,
    peerConfig,
  } = {}) {
    if (!myPeerId) throw new PeerError('myPeerId is required');
    if (role !== 'host' && role !== 'guest') {
      throw new PeerError("role must be 'host' or 'guest'");
    }

    this.myPeerId = myPeerId;
    this.role = role;
    this.peerConfig = peerConfig || undefined;
    this.onMessage = typeof onMessage === 'function' ? onMessage : () => {};
    this.onDisconnect =
      typeof onDisconnect === 'function' ? onDisconnect : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};

    this.peer = null;
    this.conn = null;

    this._peerReadyPromise = null;
    this._peerReadyError = null;
    this._connectionPromise = null;
    this._waitPromise = null;

    this._open = false;
    this._closedIntentionally = false;
    this._lastRtt = null;
    this._latencyTimer = null;
    this._pingSeq = 0;
    this._pendingPings = new Map();
    this._internalAbort = new AbortController();

    this._initPeer();
  }

  _initPeer() {
    let peer;
    try {
      peer = this.peerConfig
        ? new Peer(this.myPeerId, this.peerConfig)
        : new Peer(this.myPeerId);
    } catch (err) {
      const e = new PeerError(`failed to construct Peer: ${err.message}`, {
        cause: err,
      });
      this._peerReadyError = e;
      this.onError(e);
      return;
    }
    this.peer = peer;

    this._peerReadyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new PeerError(
          `peer broker connection timed out after ${PEER_READY_TIMEOUT_MS}ms`
        );
        try {
          peer.off('open', onOpen);
          peer.off('error', onErrorEvent);
        } catch (_) {}
        try {
          peer.destroy();
        } catch (_) {}
        this.peer = null;
        this._peerReadyError = e;
        this.onError(e);
        reject(e);
      }, PEER_READY_TIMEOUT_MS);

      const onOpen = (id) => {
        clearTimeout(timer);
        try {
          peer.off('error', onErrorEvent);
        } catch (_) {}
        if (id) this.myPeerId = id;
        resolve();
      };
      const onErrorEvent = (err) => {
        clearTimeout(timer);
        const e =
          err instanceof Error
            ? new PeerError(`peer error: ${err.message}`, {
                code: err.type || err.code,
                cause: err,
              })
            : new PeerError(`peer error: ${String(err)}`, { code: err && err.type });
        this._peerReadyError = e;
        this.onError(e);
        reject(e);
      };

      peer.on('open', onOpen);
      peer.on('error', onErrorEvent);
    });

    if (this.role === 'host') {
      peer.on('connection', (conn) => {
        if (this.conn) {
          try {
            conn.close();
          } catch (_) {}
          return;
        }
        this._wireConnection(conn);
      });
    }
  }

  async _ensurePeerReady() {
    if (this._peerReadyError) throw this._peerReadyError;
    if (!this._peerReadyPromise) {
      throw new PeerError('peer was not initialized');
    }
    await this._peerReadyPromise;
  }

  async connect(opponentPeerId) {
    if (this.role !== 'guest') {
      throw new PeerError("connect() is only valid for role='guest'");
    }
    if (!opponentPeerId) throw new PeerError('opponentPeerId is required');
    if (this._connectionPromise) return this._connectionPromise;

    this._connectionPromise = (async () => {
      await this._ensurePeerReady();
      if (!this.peer) throw new PeerError('peer unavailable');

      let conn;
      try {
        conn = this.peer.connect(opponentPeerId, {
          reliable: true,
          serialization: 'binary',
        });
      } catch (err) {
        const e = new PeerError(`peer.connect failed: ${err.message}`, {
          cause: err,
        });
        this.onError(e);
        throw e;
      }
      if (!conn) {
        const e = new PeerError('peer.connect returned no connection');
        this.onError(e);
        throw e;
      }

      this._wireConnection(conn);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const e = new ConnectionError(
            `data channel open timed out after ${CONNECT_TIMEOUT_MS}ms`
          );
          this.onError(e);
          reject(e);
        }, CONNECT_TIMEOUT_MS);

        const onOpen = () => {
          clearTimeout(timer);
          try {
            conn.off('error', onErrorEvent);
          } catch (_) {}
          resolve();
        };
        const onErrorEvent = (err) => {
          clearTimeout(timer);
          const e =
            err instanceof Error
              ? new ConnectionError(`data channel error: ${err.message}`, {
                  reason: err.type || err.code,
                  cause: err,
                })
              : new ConnectionError(`data channel error: ${String(err)}`);
          this.onError(e);
          reject(e);
        };

        conn.on('open', onOpen);
        conn.on('error', onErrorEvent);
      });
    })();

    return this._connectionPromise;
  }

  async waitForConnection() {
    if (this.role !== 'host') {
      throw new PeerError("waitForConnection() is only valid for role='host'");
    }
    if (this._waitPromise) return this._waitPromise;

    this._waitPromise = (async () => {
      await this._ensurePeerReady();

      if (this._open) return;

      await new Promise((resolve, reject) => {
        const onAborted = () => {
          const e = new ConnectionError('wait aborted');
          reject(e);
        };
        if (this._internalAbort.signal.aborted) {
          onAborted();
          return;
        }
        this._internalAbort.signal.addEventListener('abort', onAborted, {
          once: true,
        });

        const checkOpen = setInterval(() => {
          if (this._open) {
            clearInterval(checkOpen);
            this._internalAbort.signal.removeEventListener('abort', onAborted);
            resolve();
          }
        }, 50);

        const safety = setTimeout(() => {
          clearInterval(checkOpen);
        }, QUEUE_TIMEOUT_MS);
        this._waitCleanup = () => {
          clearTimeout(safety);
          clearInterval(checkOpen);
          this._internalAbort.signal.removeEventListener('abort', onAborted);
        };
      });
    })();

    return this._waitPromise;
  }

  _wireConnection(conn) {
    this.conn = conn;

    conn.on('data', (data) => {
      this._handleData(data);
    });

    conn.on('open', () => {
      this._open = true;
      this._startLatencyProbes();
    });

    conn.on('close', () => {
      this._open = false;
      this._stopLatencyProbes();
      if (this._waitCleanup) {
        try {
          this._waitCleanup();
        } catch (_) {}
        this._waitCleanup = null;
      }
      if (!this._closedIntentionally) {
        try {
          this.onDisconnect({ reason: 'closed', lastRtt: this._lastRtt });
        } catch (_) {}
      }
    });

    conn.on('error', (err) => {
      const e =
        err instanceof Error
          ? new ConnectionError(`data channel error: ${err.message}`, {
              reason: err.type || err.code,
              cause: err,
            })
          : new ConnectionError(`data channel error: ${String(err)}`);
      this.onError(e);
    });

    if (conn.open) {
      this._open = true;
      this._startLatencyProbes();
    }
  }

  _handleData(data) {
    if (!data || typeof data !== 'object') return;
    const t = data.t;
    if (t === 'ping') {
      this._safeSend({ t: 'pong', n: data.n });
      return;
    }
    if (t === 'pong') {
      const n = data.n;
      const sentAt = this._pendingPings.get(n);
      if (sentAt != null) {
        this._pendingPings.delete(n);
        this._lastRtt = Date.now() - sentAt;
      }
      return;
    }
    try {
      this.onMessage(data);
    } catch (_) {}
  }

  _startLatencyProbes() {
    this._stopLatencyProbes();
    this._latencyTimer = setInterval(() => {
      if (!this._open) return;
      this._pingSeq += 1;
      const n = this._pingSeq;
      this._pendingPings.set(n, Date.now());
      this._safeSend({ t: 'ping', n });
      setTimeout(() => {
        if (this._pendingPings.has(n)) {
          this._pendingPings.delete(n);
        }
      }, LATENCY_INTERVAL_MS * 2);
    }, LATENCY_INTERVAL_MS);
  }

  _stopLatencyProbes() {
    if (this._latencyTimer) {
      clearInterval(this._latencyTimer);
      this._latencyTimer = null;
    }
    this._pendingPings.clear();
  }

  _safeSend(message) {
    if (!this.conn || !this._open) return false;
    try {
      this.conn.send(message);
      return true;
    } catch (err) {
      const e =
        err instanceof Error
          ? new ConnectionError(`send failed: ${err.message}`, { cause: err })
          : new ConnectionError(`send failed: ${String(err)}`);
      this.onError(e);
      return false;
    }
  }

  send(message) {
    if (!this.isOpen) {
      throw new ConnectionError('connection is not open');
    }
    if (!message || typeof message !== 'object') {
      throw new PeerError('message must be a plain object');
    }
    return this._safeSend(message);
  }

  close(reason) {
    this._closedIntentionally = true;
    this._stopLatencyProbes();

    if (this.conn && this._open) {
      try {
        this.conn.send({ t: 'goodbye', reason: reason || 'normal' });
      } catch (_) {}
    }

    try {
      if (this.conn) this.conn.close();
    } catch (_) {}
    this.conn = null;
    this._open = false;

    try {
      this._internalAbort.abort();
    } catch (_) {}

    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (_) {}
      this.peer = null;
    }
  }

  get isOpen() {
    return !!(this.conn && this._open);
  }

  get latency() {
    return this._lastRtt;
  }
}

export default { MatchClient, PeerConnection, QueueError, PeerError, ConnectionError };
