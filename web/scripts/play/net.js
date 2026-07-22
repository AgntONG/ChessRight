import Peer from 'https://esm.sh/peerjs@1.5.4?bundle';

const DEFAULT_API_BASE = '/api';
const DEFAULT_TIMECONTROL = '10+5';
const QUEUE_TIMEOUT_MS = 120000;
const PEER_READY_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 15000;
const HELLO_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 5000;
const LATENCY_INTERVAL_MS = 5000;
const CONNECT_RETRY_ATTEMPTS = 3;
const CONNECT_RETRY_DELAY_MS = 2000;
const PEER_RECONNECT_DELAY_MS = 1000;
const PEER_RECONNECT_MAX_ATTEMPTS = 5;
const PEER_REREGISTER_DELAY_MS = 2000;
const PEER_KEEPALIVE_INTERVAL_MS = 30000;
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const INVITE_PREFIX = 'CR-';
const INVITE_PEER_NAMESPACE = 'chessright-invite-';
const PEER_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const DEFAULT_PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ],
  },
};

function generateCode(len = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (let i = 0; i < len; i++) {
    s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return s;
}

function generateInviteCode() {
  return INVITE_PREFIX + generateCode(6);
}

function normalizeCode(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return null;
  return trimmed.startsWith(INVITE_PREFIX) ? trimmed : INVITE_PREFIX + trimmed;
}

function inviteCodeToPeerId(code) {
  return INVITE_PEER_NAMESPACE + code;
}

function buildShareUrl(code) {
  try {
    return new URL('?join=' + encodeURIComponent(code), window.location.href).href;
  } catch (_) {
    return '?join=' + encodeURIComponent(code);
  }
}

export function parseInviteFromUrl(href) {
  try {
    const ref = href || (typeof window !== 'undefined' ? window.location.href : '');
    if (!ref) return null;
    const url = new URL(ref);
    const raw = url.searchParams.get('join');
    return raw ? normalizeCode(raw) : null;
  } catch (_) {
    return null;
  }
}

function generatePeerId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = 'peer_';
  for (let i = 0; i < bytes.length; i++) {
    out += PEER_ID_ALPHABET[bytes[i] % PEER_ID_ALPHABET.length];
  }
  return out;
}

function invertColor(c) {
  return c === 'w' ? 'b' : 'w';
}

function withTimeout(ms, label) {
  let timer;
  const p = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectionError(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  const cancel = () => clearTimeout(timer);
  return { promise: p, cancel };
}

const PEER_ERROR_MESSAGES = {
  'browser-incompatible': 'Your browser does not support WebRTC.',
  'disconnected': 'Lost connection to the matchmaking broker.',
  'invalid-id': 'Invalid peer identifier.',
  'network': 'Network error reaching the matchmaking broker.',
  'peer-unavailable': 'Host not found \u2014 the invite may have expired or the host left.',
  'ssl-unavailable': 'Secure connection (HTTPS/TLS) is required for matchmaking.',
  'server-error': 'The matchmaking broker returned an error.',
  'socket-error': 'WebSocket connection to the broker failed.',
  'socket-closed': 'WebSocket connection to the broker closed unexpectedly.',
  'unavailable-id': 'That peer identifier is already taken.',
  'ice-failed': 'Could not establish a direct connection (NAT/firewall blocked WebRTC).',
};

function mapPeerErrorType(type) {
  return type || 'network';
}

function describePeerError(type, message, fallback) {
  const key = mapPeerErrorType(type);
  const mapped = PEER_ERROR_MESSAGES[key];
  if (mapped) return mapped;
  if (message) return message;
  return fallback || 'Peer connection error.';
}

function isRetryablePeerError(type) {
  const t = mapPeerErrorType(type);
  return (
    t === 'peer-unavailable' ||
    t === 'network' ||
    t === 'server-error' ||
    t === 'socket-error' ||
    t === 'socket-closed' ||
    t === 'disconnected'
  );
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

  async isServerAvailable() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiBase}/health`, {
        method: 'GET',
        headers: this._headers(),
        signal: controller.signal,
        cache: 'no-store',
      });
      return res.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
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
    } catch (_) {}
  }

  async leaveQueue(ticketId) {
    const id = ticketId || this._currentTicketId;
    if (!id) return;
    this._currentTicketId = null;
    await this._safeLeave(id);
  }
}

export class PeerConnection {
  constructor({
    myPeerId,
    role,
    onMessage,
    onOpen,
    onDisconnect,
    onError,
    onStatusChange,
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
    this.onOpen = typeof onOpen === 'function' ? onOpen : () => {};
    this.onDisconnect =
      typeof onDisconnect === 'function' ? onDisconnect : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.onStatusChange =
      typeof onStatusChange === 'function' ? onStatusChange : () => {};

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

    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._reregisterTimer = null;
    this._keepaliveTimer = null;

    this._initPeer();
  }

  _emitStatus(status) {
    try {
      this.onStatusChange(status);
    } catch (_) {}
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
      this._emitStatus('failed');
      return;
    }
    this.peer = peer;
    this._emitStatus('connecting');

    this._peerReadyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = new PeerError(
          `peer broker connection timed out after ${PEER_READY_TIMEOUT_MS}ms`,
          { code: 'network' }
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
        this._emitStatus('failed');
        reject(e);
      }, PEER_READY_TIMEOUT_MS);

      const onOpen = (id) => {
        clearTimeout(timer);
        try {
          peer.off('error', onErrorEvent);
        } catch (_) {}
        if (id) this.myPeerId = id;
        this._reconnectAttempts = 0;
        this._startKeepalive();
        this._emitStatus('connected');
        resolve();
      };
      const onErrorEvent = (err) => {
        clearTimeout(timer);
        const type = err && (err.type || err.code);
        const message =
          err instanceof Error ? err.message : String(err);
        const e = new PeerError(
          `peer error: ${describePeerError(type, message, message)}`,
          { code: type, cause: err instanceof Error ? err : undefined }
        );
        this._peerReadyError = e;
        this.onError(e);
        this._emitStatus('failed');
        reject(e);
      };

      peer.on('open', onOpen);
      peer.on('error', onErrorEvent);
    });

    peer.on('error', (err) => {
      if (this._closedIntentionally) return;
      const type = err && (err.type || err.code);
      const message = err instanceof Error ? err.message : String(err);
      const e = new PeerError(
        `peer error: ${describePeerError(type, message, message)}`,
        { code: type, cause: err instanceof Error ? err : undefined }
      );
      this.onError(e);
      if (type === 'peer-unavailable') return;
      if (!isRetryablePeerError(type)) this._emitStatus('failed');
    });

    peer.on('disconnected', () => {
      if (this._closedIntentionally) return;
      this._stopKeepalive();
      this._emitStatus('reconnecting');
      this._scheduleReconnect();
    });

    peer.on('close', () => {
      if (this._closedIntentionally) return;
      this._stopKeepalive();
      if (this.role === 'host') {
        this._emitStatus('reconnecting');
        this._scheduleReregister();
      } else {
        this._emitStatus('failed');
      }
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

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    if (this._reconnectAttempts >= PEER_RECONNECT_MAX_ATTEMPTS) {
      const e = new PeerError(
        'gave up reconnecting to the broker after ' +
          PEER_RECONNECT_MAX_ATTEMPTS +
          ' attempts',
        { code: 'network' }
      );
      this.onError(e);
      this._emitStatus('failed');
      return;
    }
    this._reconnectAttempts += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._closedIntentionally || !this.peer) return;
      try {
        this.peer.reconnect();
      } catch (_) {}
    }, PEER_RECONNECT_DELAY_MS);
  }

  _scheduleReregister() {
    if (this._reregisterTimer) return;
    this._reregisterTimer = setTimeout(() => {
      this._reregisterTimer = null;
      if (this._closedIntentionally) return;
      try {
        if (this.peer) {
          this.peer.destroy();
        }
      } catch (_) {}
      this.peer = null;
      this._reconnectAttempts = 0;
      this._initPeer();
    }, PEER_REREGISTER_DELAY_MS);
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (this._closedIntentionally || !this.peer) return;
      if (this.peer.open === false || this.peer.disconnected === true) {
        if (!this.peer.disconnected) {
          try {
            this.peer.reconnect();
          } catch (_) {}
        }
      }
    }, PEER_KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  async ready() {
    if (this._peerReadyError) throw this._peerReadyError;
    if (!this._peerReadyPromise) {
      throw new PeerError('peer was not initialized');
    }
    await this._peerReadyPromise;
  }

  async connect(targetPeerId, attempts = CONNECT_RETRY_ATTEMPTS) {
    if (this.role !== 'guest') {
      throw new PeerError("connect() is only valid for role='guest'");
    }
    if (!targetPeerId) throw new PeerError('targetPeerId is required');
    if (this._connectionPromise) return this._connectionPromise;

    this._connectionPromise = (async () => {
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        try {
          return await this._connectOnce(targetPeerId);
        } catch (err) {
          lastErr = err;
          const code = err && (err.code || err.reason);
          if (
            err instanceof PeerError ||
            err instanceof ConnectionError ||
            isRetryablePeerError(code)
          ) {
            if (i < attempts - 1) {
              await new Promise((r) => setTimeout(r, CONNECT_RETRY_DELAY_MS));
              continue;
            }
          }
          throw err;
        }
      }
      throw lastErr;
    })();

    return this._connectionPromise;
  }

  async _connectOnce(targetPeerId) {
    await this.ready();
    if (!this.peer) throw new PeerError('peer unavailable');

    let conn;
    try {
      conn = this.peer.connect(targetPeerId, {
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
          `data channel open timed out after ${CONNECT_TIMEOUT_MS}ms`,
          { reason: 'timeout' }
        );
        try { conn.off('open', onOpen); conn.off('error', onErrorEvent); } catch (_) {}
        try { conn.close(); } catch (_) {}
        if (this.conn === conn) this.conn = null;
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
        const type = err && (err.type || err.code);
        const message = err instanceof Error ? err.message : String(err);
        const e = new ConnectionError(
          `data channel error: ${describePeerError(type, message, message)}`,
          {
            reason: mapPeerErrorType(type),
            cause: err instanceof Error ? err : undefined,
          }
        );
        try { conn.off('open', onOpen); } catch (_) {}
        if (this.conn === conn) this.conn = null;
        this.onError(e);
        reject(e);
      };

      conn.on('open', onOpen);
      conn.on('error', onErrorEvent);
    });
  }

  async waitForConnection() {
    if (this.role !== 'host') {
      throw new PeerError("waitForConnection() is only valid for role='host'");
    }
    if (this._waitPromise) return this._waitPromise;

    this._waitPromise = (async () => {
      await this.ready();

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

    const fireOpen = () => {
      this._open = true;
      this._startLatencyProbes();
      try {
        this.onOpen();
      } catch (_) {}
    };

    conn.on('data', (data) => {
      this._handleData(data);
    });

    conn.on('open', fireOpen);

    conn.on('close', () => {
      this._open = false;
      this._stopLatencyProbes();
      if (this.conn === conn) this.conn = null;
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
      fireOpen();
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
    this._stopKeepalive();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._reregisterTimer) {
      clearTimeout(this._reregisterTimer);
      this._reregisterTimer = null;
    }

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

class InviteSession {
  constructor({ handle, rating, isHost, peerConfig }) {
    this._handle = handle || (isHost ? 'Host' : 'Guest');
    this._rating = typeof rating === 'number' ? rating : null;
    this._isHost = !!isHost;
    this._peerConfig = peerConfig || DEFAULT_PEER_CONFIG;
    this._conn = null;
    this._peerHello = null;
    this._helloSent = false;
    this._helloDone = false;
    this._helloPromise = null;
    this._helloResolve = null;
    this._helloReject = null;
    this._helloTimer = null;
    this._closed = false;
    this.onMessage = () => {};
  }

  _bindConnection(conn) {
    this._conn = conn;
    this._helloPromise = new Promise((resolve, reject) => {
      this._helloResolve = resolve;
      this._helloReject = reject;
    });
  }

  _startHelloTimer() {
    if (this._helloTimer || this._helloDone || this._closed) return;
    this._helloTimer = setTimeout(() => {
      const e = new ConnectionError(
        `hello handshake timed out after ${HELLO_TIMEOUT_MS}ms`
      );
      this._failHandshake(e);
    }, HELLO_TIMEOUT_MS);
  }

  _sendHello(extra) {
    if (!this._conn || !this._conn.isOpen) return;
    if (this._helloSent) return;
    this._helloSent = true;
    this._startHelloTimer();
    this._conn.send({
      t: 'hello',
      handle: this._handle,
      rating: this._rating,
      isHost: this._isHost,
      ...(extra || {}),
    });
  }

  _handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') {
      if (!this._helloSent) this._sendHello();
      if (!this._peerHello) {
        this._peerHello = {
          handle: msg.handle || (this._isHost ? 'Guest' : 'Host'),
          rating: typeof msg.rating === 'number' ? msg.rating : null,
          color: msg.color || null,
          isHost: !!msg.isHost,
        };
      }
      this._completeHello();
      return;
    }
    if (this._helloDone) {
      this.onMessage(msg);
    }
  }

  _completeHello() {
    if (this._helloDone) return;
    this._helloDone = true;
    if (this._helloTimer) {
      clearTimeout(this._helloTimer);
      this._helloTimer = null;
    }
    if (this._helloResolve) {
      this._helloResolve(this._peerHello);
      this._helloResolve = null;
      this._helloReject = null;
    }
  }

  _failHandshake(err) {
    if (this._helloReject) {
      const reject = this._helloReject;
      this._helloResolve = null;
      this._helloReject = null;
      if (this._helloTimer) {
        clearTimeout(this._helloTimer);
        this._helloTimer = null;
      }
      reject(err);
    }
  }

  async _awaitHello() {
    if (!this._helloPromise) {
      throw new ConnectionError('hello handshake was not initialized');
    }
    return this._helloPromise;
  }

  _onDisconnect(info, onPeerGone) {
    if (!this._helloDone) {
      this._failHandshake(
        new ConnectionError('peer disconnected before hello handshake completed', {
          reason: (info && info.reason) || 'closed',
        })
      );
    }
    if (typeof onPeerGone === 'function') {
      try {
        onPeerGone(info);
      } catch (_) {}
    }
  }

  send(message) {
    if (!this._conn) throw new ConnectionError('invite session not connected');
    return this._conn.send(message);
  }

  get isOpen() {
    return !!(this._conn && this._conn.isOpen);
  }

  get latency() {
    return this._conn ? this._conn.latency : null;
  }
}

export class InviteHost {
  constructor({
    handle,
    rating,
    onGuestConnected,
    onGuestDisconnected,
    onError,
    onStatusChange,
    peerConfig,
  } = {}) {
    this._handle = handle;
    this._rating = rating;
    this._onGuestConnected =
      typeof onGuestConnected === 'function' ? onGuestConnected : () => {};
    this._onGuestDisconnected =
      typeof onGuestDisconnected === 'function' ? onGuestDisconnected : () => {};
    this._onError = typeof onError === 'function' ? onError : () => {};
    this._onStatusChange =
      typeof onStatusChange === 'function' ? onStatusChange : () => {};
    this._peerConfig = peerConfig || DEFAULT_PEER_CONFIG;

    this._code = null;
    this._peerId = null;
    this._hostColor = null;
    this._session = null;
    this._cancelled = false;

    this.onMessage = () => {};
  }

  get code() {
    return this._code;
  }

  get shareUrl() {
    return this._code ? buildShareUrl(this._code) : null;
  }

  get peerId() {
    return this._peerId;
  }

  get isOpen() {
    return !!(this._session && this._session.isOpen);
  }

  get latency() {
    return this._session ? this._session.latency : null;
  }

  async create() {
    if (this._session) throw new PeerError('create() already called');

    this._code = generateInviteCode();
    this._peerId = inviteCodeToPeerId(this._code);
    this._hostColor = Math.random() < 0.5 ? 'w' : 'b';

    const session = new InviteSession({
      handle: this._handle,
      rating: this._rating,
      isHost: true,
      peerConfig: this._peerConfig,
    });
    session.onMessage = (msg) => this.onMessage(msg);
    this._session = session;

    const conn = new PeerConnection({
      myPeerId: this._peerId,
      role: 'host',
      peerConfig: this._peerConfig,
      onOpen: () => {
        session._sendHello({ color: this._hostColor });
      },
      onMessage: (msg) => session._handleIncoming(msg),
      onDisconnect: (info) => {
        session._onDisconnect(info, (i) => {
          if (session._helloDone) this._onGuestDisconnected(i);
        });
      },
      onError: (err) => this._onError(err),
      onStatusChange: (status) => this._onStatusChange(status),
    });
    session._bindConnection(conn);

    await conn.ready().catch((err) => {
      this._session = null;
      throw err;
    });

    conn.waitForConnection().catch((err) => {
      if (!this._cancelled) this._onError(err);
    });

    session._awaitHello()
      .then((peerHello) => {
        const guestColor = invertColor(this._hostColor);
        try {
          this._onGuestConnected({
            guestHandle: peerHello.handle,
            guestRating: peerHello.rating,
            myColor: this._hostColor,
            guestColor,
          });
        } catch (_) {}
      })
      .catch((err) => {
        if (!this._cancelled) this._onError(err);
      });

    return { code: this._code, shareUrl: this.shareUrl, peerId: this._peerId };
  }

  async cancel() {
    this._cancelled = true;
    const session = this._session;
    this._session = null;
    if (session && session._conn) {
      try {
        session._conn.close('host-cancelled');
      } catch (_) {}
    }
  }

  send(message) {
    if (!this._session) throw new ConnectionError('invite host not active');
    return this._session.send(message);
  }

  close(reason) {
    return this.cancel(reason);
  }
}

export class InviteGuest {
  constructor({
    handle,
    rating,
    onHostConnected,
    onHostDisconnected,
    onError,
    onStatusChange,
    peerConfig,
  } = {}) {
    this._handle = handle;
    this._rating = rating;
    this._onHostConnected =
      typeof onHostConnected === 'function' ? onHostConnected : () => {};
    this._onHostDisconnected =
      typeof onHostDisconnected === 'function' ? onHostDisconnected : () => {};
    this._onError = typeof onError === 'function' ? onError : () => {};
    this._onStatusChange =
      typeof onStatusChange === 'function' ? onStatusChange : () => {};
    this._peerConfig = peerConfig || DEFAULT_PEER_CONFIG;

    this._myPeerId = null;
    this._hostPeerId = null;
    this._hostColor = null;
    this._myColor = null;
    this._session = null;
    this._left = false;

    this.onMessage = () => {};
  }

  get myPeerId() {
    return this._myPeerId;
  }

  get hostPeerId() {
    return this._hostPeerId;
  }

  get isOpen() {
    return !!(this._session && this._session.isOpen);
  }

  get latency() {
    return this._session ? this._session.latency : null;
  }

  async join(code, options = {}) {
    if (this._session) throw new PeerError('join() already called');
    const signal = options.signal;
    if (signal && signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const normalized = normalizeCode(code);
    if (!normalized) throw new PeerError('invalid invite code');

    this._hostPeerId = inviteCodeToPeerId(normalized);
    this._myPeerId = generatePeerId();

    const session = new InviteSession({
      handle: this._handle,
      rating: this._rating,
      isHost: false,
      peerConfig: this._peerConfig,
    });
    session.onMessage = (msg) => this.onMessage(msg);
    this._session = session;

    const onAbort = () => {
      this._failBeforeReady(new DOMException('Aborted', 'AbortError'));
    };
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const conn = new PeerConnection({
      myPeerId: this._myPeerId,
      role: 'guest',
      peerConfig: this._peerConfig,
      onOpen: () => {
        session._sendHello();
      },
      onMessage: (msg) => session._handleIncoming(msg),
      onDisconnect: (info) => {
        session._onDisconnect(info, (i) => {
          if (session._helloDone) this._onHostDisconnected(i);
        });
      },
      onError: (err) => this._onError(err),
      onStatusChange: (status) => this._onStatusChange(status),
    });
    session._bindConnection(conn);

    try {
      await conn.ready();
      await conn.connect(this._hostPeerId);
      const peerHello = await session._awaitHello();

      this._hostColor = peerHello.color || 'w';
      this._myColor = invertColor(this._hostColor);

      const info = {
        hostPeerId: this._hostPeerId,
        hostHandle: peerHello.handle,
        hostRating: peerHello.rating,
        hostColor: this._hostColor,
        myColor: this._myColor,
      };
      try {
        this._onHostConnected(info);
      } catch (_) {}
      return info;
    } catch (err) {
      this._failBeforeReady(err);
      throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  _failBeforeReady(err) {
    const session = this._session;
    this._session = null;
    if (session && session._conn) {
      try {
        session._conn.close('aborted');
      } catch (_) {}
    }
    if (err && err.name === 'AbortError') throw err;
  }

  async leave() {
    this._left = true;
    const session = this._session;
    this._session = null;
    if (session && session._conn) {
      try {
        session._conn.close('guest-left');
      } catch (_) {}
    }
  }

  send(message) {
    if (!this._session) throw new ConnectionError('invite guest not connected');
    return this._session.send(message);
  }

  close(reason) {
    return this.leave(reason);
  }
}

export default {
  MatchClient,
  PeerConnection,
  InviteHost,
  InviteGuest,
  QueueError,
  PeerError,
  ConnectionError,
  parseInviteFromUrl,
  DEFAULT_PEER_CONFIG,
};
