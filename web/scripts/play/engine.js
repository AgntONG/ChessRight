const DEFAULT_WORKER_URL = 'assets/stockfish/stockfish-nnue-16-single.js';
const DEFAULT_CDN_URL = 'https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js';

const LEVELS = [
  { movetime: 100,  skill:  0, depth: 8  },
  { movetime: 100,  skill:  1, depth: 8  },
  { movetime: 150,  skill:  2, depth: 9  },
  { movetime: 150,  skill:  3, depth: 9  },
  { movetime: 200,  skill:  4, depth: 10 },
  { movetime: 200,  skill:  5, depth: 10 },
  { movetime: 300,  skill:  6, depth: 11 },
  { movetime: 300,  skill:  7, depth: 12 },
  { movetime: 400,  skill:  8, depth: 12 },
  { movetime: 400,  skill:  9, depth: 13 },
  { movetime: 500,  skill: 10, depth: 14 },
  { movetime: 500,  skill: 11, depth: 14 },
  { movetime: 600,  skill: 12, depth: 15 },
  { movetime: 600,  skill: 13, depth: 15 },
  { movetime: 700,  skill: 14, depth: 16 },
  { movetime: 800,  skill: 15, depth: 16 },
  { movetime: 900,  skill: 16, depth: 17 },
  { movetime: 1000, skill: 17, depth: 17 },
  { movetime: 1200, skill: 19, depth: 18 },
  { movetime: 1500, skill: 20, depth: 18 },
];

function levelConfig(level) {
  const idx = Math.max(0, Math.min(LEVELS.length - 1, Math.round(level) - 1));
  return LEVELS[idx];
}

function mateToCp(mate) {
  if (mate > 0) return 10000 - mate * 100;
  if (mate < 0) return -10000 - mate * 100;
  return 0;
}

function parseUci(uci) {
  if (!uci || typeof uci !== 'string' || uci.length < 4 || uci === '(none)') {
    return null;
  }
  return {
    best: uci,
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length >= 5 ? uci.slice(4, 5) : null,
  };
}

function parseInfoLine(line) {
  const tokens = line.split(/\s+/);
  const info = { depth: null, cp: null, mate: null, pv: [] };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'depth' && tokens[i + 1] !== undefined) {
      info.depth = parseInt(tokens[i + 1], 10);
      i++;
    } else if (t === 'cp' && tokens[i + 1] !== undefined) {
      info.cp = parseInt(tokens[i + 1], 10);
      i++;
    } else if (t === 'mate' && tokens[i + 1] !== undefined) {
      info.mate = parseInt(tokens[i + 1], 10);
      i++;
    } else if (t === 'pv') {
      info.pv = tokens.slice(i + 1);
      break;
    }
  }
  return info;
}

export class Engine {
  constructor({ workerUrl, cdnUrl, onError, onLoad } = {}) {
    this.workerUrl = workerUrl || DEFAULT_WORKER_URL;
    this.cdnUrl = cdnUrl !== undefined ? cdnUrl : DEFAULT_CDN_URL;
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.onLoad = typeof onLoad === 'function' ? onLoad : () => {};

    this.worker = null;
    this.readyPromise = null;
    this.engineReady = false;
    this.level = 20;
    this.nnueEnabled = false;

    this.commandQueue = Promise.resolve();
    this.pendingReady = null;
    this.currentSearch = null;
    this.lastInfo = null;
    this.messageHandler = null;
    this.errorHandler = null;
  }

  _spawnWorker(url) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(url, { type: 'classic' });
      } catch (err) {
        reject(err);
        return;
      }

      const onErrorEvent = (event) => {
        worker.removeEventListener('error', onErrorEvent);
        worker.removeEventListener('message', readyPoll);
        const message = event && event.message ? event.message : 'worker error';
        reject(new Error(message));
      };

      const readyPoll = (event) => {
        const text = typeof event.data === 'string' ? event.data : '';
        if (text.includes('uciok')) {
          worker.removeEventListener('error', onErrorEvent);
          worker.removeEventListener('message', readyPoll);
          resolve(worker);
        }
      };

      worker.addEventListener('error', onErrorEvent);
      worker.addEventListener('message', readyPoll);
      try {
        worker.postMessage('uci');
      } catch (err) {
        reject(err);
      }
    });
  }

  async _tryLoad() {
    const candidates = [this.workerUrl];
    if (this.cdnUrl && !candidates.includes(this.cdnUrl)) {
      candidates.push(this.cdnUrl);
    }

    let lastError = null;
    for (const url of candidates) {
      try {
        this.worker = await this._spawnWorker(url);
        this.workerUrlUsed = url;
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('failed to load stockfish worker');
  }

  async ready() {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      try {
        await this._tryLoad();
        this._installHandlers();
        await this._handshake();
        this.engineReady = true;
        this.onLoad();
      } catch (err) {
        this.onError(err);
        if (this.worker) {
          try { this.worker.terminate(); } catch (_) {}
          this.worker = null;
        }
        this.readyPromise = null;
        throw new Error(`Stockfish failed to load: ${err && err.message ? err.message : err}`);
      }
    })();

    return this.readyPromise;
  }

  _installHandlers() {
    const worker = this.worker;
    this.messageHandler = (event) => {
      const raw = typeof event.data === 'string' ? event.data : '';
      if (!raw) return;
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this._dispatch(trimmed);
      }
    };
    this.errorHandler = (event) => {
      const message = event && event.message ? event.message : 'worker error';
      const err = new Error(message);
      this.onError(err);
      if (this.pendingReady) {
        this.pendingReady.reject(err);
        this.pendingReady = null;
      }
      if (this.currentSearch) {
        this.currentSearch.reject(err);
        this.currentSearch = null;
      }
    };
    worker.addEventListener('message', this.messageHandler);
    worker.addEventListener('error', this.errorHandler);
  }

  _dispatch(line) {
    if (line === 'readyok') {
      if (this.pendingReady) {
        this.pendingReady.resolve();
        this.pendingReady = null;
      }
      return;
    }

    if (this.nnueProbe) {
      if (/Load eval file success/i.test(line)) this.nnueEnabled = true;
      if (/Failed to download eval file/i.test(line)) {
        this.nnueEnabled = false;
        this._nnueFailed = true;
      }
    }

    if (line === 'uciok') return;

    if (line.startsWith('info')) {
      const info = parseInfoLine(line);
      if (info.depth === null && info.cp === null && info.mate === null) return;
      if (info.mate !== null && info.cp === null) info.cp = mateToCp(info.mate);
      this.lastInfo = info;
      if (this.currentSearch && this.currentSearch.onInfo) {
        try { this.currentSearch.onInfo({ ...info }); } catch (_) {}
      }
      return;
    }

    const bestMatch = line.match(/^bestmove\s+(\S+)(?:\s+ponder\s+(\S+))?/);
    if (bestMatch) {
      if (!this.currentSearch) return;
      const search = this.currentSearch;
      this.currentSearch = null;
      const rawBest = bestMatch[1];
      const ponder = bestMatch[2] || null;
      const info = this.lastInfo || { depth: null, cp: null, mate: null, pv: [] };
      const parsed = parseUci(rawBest);
      if (!parsed) {
        search.resolve({ best: null, ponder: null, ...info });
        return;
      }
      search.resolve({ ...parsed, ponder, ...info });
      return;
    }
  }

  _send(command) {
    if (!this.worker) throw new Error('engine worker not initialized');
    this.worker.postMessage(command);
  }

  async _sendReady({ timeoutMs = 5000 } = {}) {
    if (!this.worker) throw new Error('engine not ready');
    if (this.pendingReady) await this.pendingReady.promise;

    this.pendingReady = (() => {
      let resolve, reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    })();
    this._send('isready');
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('isready timeout')), timeoutMs);
    });
    await Promise.race([this.pendingReady.promise, timeout]).catch((err) => {
      if (this.pendingReady) {
        this.pendingReady.reject(err);
        this.pendingReady = null;
      }
      throw err;
    });
  }

  async _enqueue(task) {
    const run = this.commandQueue.then(task, task);
    this.commandQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async _handshake() {
    this._send('setoption name Hash value 64');
    this._send('setoption name UCI_Chess960 value false');
    await this._sendReady();
    this._send('ucinewgame');
    await this._sendReady();
  }

  async setLevel(level) {
    return this._enqueue(async () => {
      await this.ready();
      const clamped = Math.max(1, Math.min(LEVELS.length, level | 0));
      this.level = clamped;
      const cfg = levelConfig(clamped);
      this._send(`setoption name Skill Level value ${cfg.skill}`);
      await this._sendReady();
    });
  }

  async newGame() {
    return this._enqueue(async () => {
      await this.ready();
      this._send('ucinewgame');
      await this._sendReady();
    });
  }

  _positionCommand(fen, moves) {
    if (fen) {
      const trimmed = fen.trim();
      if (moves && moves.length) {
        return `position fen ${trimmed} moves ${moves.join(' ')}`;
      }
      return `position fen ${trimmed}`;
    }
    if (moves && moves.length) {
      return `position startpos moves ${moves.join(' ')}`;
    }
    return 'position startpos';
  }

  _resolveDepthMovetime(overrides) {
    const cfg = levelConfig(this.level);
    const movetime = overrides.movetime != null ? overrides.movetime : cfg.movetime;
    const depth = overrides.depth != null ? overrides.depth : cfg.depth;
    return { movetime, depth };
  }

  _goCommand({ depth, movetime }) {
    const parts = ['go'];
    if (movetime != null) parts.push('movetime', String(movetime | 0));
    if (depth != null) parts.push('depth', String(depth | 0));
    return parts.join(' ');
  }

  _startSearch({ fen, moves, depth, movetime, onInfo }) {
    if (this.currentSearch) {
      this._send('stop');
      const previous = this.currentSearch;
      this.currentSearch = null;
      previous.reject(new Error('superseded by a new search'));
    }

    this.lastInfo = null;
    this._send(this._positionCommand(fen, moves));
    const resolved = this._resolveDepthMovetime({ depth, movetime });
    this._send(this._goCommand(resolved));

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.currentSearch = {
      resolve,
      reject,
      onInfo: typeof onInfo === 'function' ? onInfo : null,
    };

    const cap = Math.max(resolved.movetime || 0, (resolved.depth || 1) * 1500) + 8000;
    const timer = setTimeout(() => {
      if (this.currentSearch && this.currentSearch.reject === reject) {
        this._send('stop');
      }
    }, cap);

    return promise.finally(() => clearTimeout(timer));
  }

  async bestMove({ fen, moves, depth, movetime } = {}) {
    await this.ready();
    return this._enqueue(() => this._startSearch({ fen, moves, depth, movetime, onInfo: null }));
  }

  async analyze({ fen, moves, depth, movetime, onInfo } = {}) {
    await this.ready();
    return this._enqueue(() => this._startSearch({ fen, moves, depth, movetime, onInfo }));
  }

  async deepAnalyze({ fen, moves, depth = 22, movetime = 4000, onInfo } = {}) {
    await this.ready();
    const prevLevel = this.level;
    this._send('setoption name Skill Level value 20');
    await this._sendReady();
    const result = await this._enqueue(() => this._startSearch({ fen, moves, depth, movetime, onInfo }));
    this._send(`setoption name Skill Level value ${levelConfig(prevLevel).skill}`);
    try { await this._sendReady(); } catch (_) {}
    return result;
  }

  isNnueEnabled() { return !!this.nnueEnabled; }

  stop() {
    if (this.worker && this.currentSearch) this._send('stop');
  }

  quit() {
    if (this.currentSearch) {
      this.currentSearch.reject(new Error('engine quit'));
      this.currentSearch = null;
    }
    if (this.pendingReady) {
      this.pendingReady.reject(new Error('engine quit'));
      this.pendingReady = null;
    }
    if (this.worker) {
      try { this._send('quit'); } catch (_) {}
      try { this.worker.terminate(); } catch (_) {}
      if (this.messageHandler) this.worker.removeEventListener('message', this.messageHandler);
      if (this.errorHandler) this.worker.removeEventListener('error', this.errorHandler);
      this.worker = null;
    }
    this.engineReady = false;
    this.readyPromise = null;
    this.commandQueue = Promise.resolve();
  }
}

export { LEVELS };

const CLOUD_APIS = [
  {
    name: 'chess-api.com',
    url: 'https://chess-api.com/v1',
    async bestMove(fen, depth, movetime) {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fen,
          depth: Math.min(depth || 12, 18),
          maxThinkingTime: Math.min(Math.max(movetime || 200, 100), 100),
        }),
      });
      if (!res.ok) throw new Error(`chess-api.com returned ${res.status}`);
      const data = await res.json();
      if (!data || !data.move) throw new Error('chess-api.com: no move');
      return {
        best: data.lan || data.move,
        cp: data.centipawns ? parseInt(data.centipawns, 10) : (data.eval ? Math.round(data.eval * 100) : null),
        mate: data.mate,
        depth: data.depth || null,
        pv: data.continuationArr || [],
      };
    },
  },
  {
    name: 'stockfish.online',
    url: 'https://stockfish.online/api/stockfish.php',
    async bestMove(fen, depth, movetime) {
      const params = new URLSearchParams({
        fen,
        depth: String(Math.min(depth || 12, 15)),
        mode: 'bestmove',
      });
      const res = await fetch(`${this.url}?${params}`);
      if (!res.ok) throw new Error(`stockfish.online returned ${res.status}`);
      const data = await res.json();
      if (!data || !data.bestmove) throw new Error('stockfish.online: no move');
      const uci = data.bestmove.split(' ')[0];
      if (!uci || uci.length < 4) throw new Error('stockfish.online: bad move');
      return {
        best: uci,
        cp: data.eval_cp ? parseInt(data.eval_cp, 10) : null,
        mate: data.eval_mate,
        depth: data.depth || null,
        pv: [],
      };
    },
  },
];

export class CloudEngine {
  constructor({ onError } = {}) {
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.apiIndex = 0;
    this.level = 8;
  }

  async ready() {
    const cfg = levelConfig(this.level);
    const api = CLOUD_APIS[this.apiIndex];
    try {
      const test = await api.bestMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 5, 50);
      if (!test || !test.best) throw new Error('no move returned');
    } catch (err) {
      if (this.apiIndex < CLOUD_APIS.length - 1) {
        this.apiIndex++;
        return this.ready();
      }
      throw err;
    }
  }

  async setLevel(level) {
    this.level = level;
  }

  async newGame() {}

  async bestMove({ fen }) {
    const cfg = levelConfig(this.level);
    const api = CLOUD_APIS[this.apiIndex];
    try {
      return await api.bestMove(fen, cfg.depth, cfg.movetime);
    } catch (err) {
      for (let i = 0; i < CLOUD_APIS.length; i++) {
        if (i === this.apiIndex) continue;
        try {
          const result = await CLOUD_APIS[i].bestMove(fen, cfg.depth, cfg.movetime);
          this.apiIndex = i;
          return result;
        } catch (_) {}
      }
      throw err;
    }
  }

  async analyze({ fen, depth, movetime }) {
    const cfg = levelConfig(this.level);
    return this.bestMove({ fen, depth, movetime });
  }

  quit() {}

  isNnueEnabled() { return true; }

  get nnueEnabled() { return true; }
}
