const MIN = 60 * 1000;

export const TIME_CONTROLS = [
  { id: '1+0',  label: 'Bullet 1+0',  initialMs: 1 * MIN,  incrementMs: 0,       category: 'bullet' },
  { id: '2+1',  label: 'Bullet 2+1',  initialMs: 2 * MIN,  incrementMs: 1000,    category: 'bullet' },
  { id: '3+0',  label: 'Blitz 3+0',   initialMs: 3 * MIN,  incrementMs: 0,       category: 'blitz' },
  { id: '3+2',  label: 'Blitz 3+2',   initialMs: 3 * MIN,  incrementMs: 2000,    category: 'blitz' },
  { id: '5+0',  label: 'Blitz 5+0',   initialMs: 5 * MIN,  incrementMs: 0,       category: 'blitz' },
  { id: '5+3',  label: 'Blitz 5+3',   initialMs: 5 * MIN,  incrementMs: 3000,    category: 'blitz' },
  { id: '10+0', label: 'Rapid 10+0',  initialMs: 10 * MIN, incrementMs: 0,       category: 'rapid' },
  { id: '10+5', label: 'Rapid 10+5',  initialMs: 10 * MIN, incrementMs: 5000,    category: 'rapid' },
  { id: '15+10',label: 'Rapid 15+10', initialMs: 15 * MIN, incrementMs: 10 * 1000, category: 'rapid' },
  { id: '30+0', label: 'Classical 30+0',  initialMs: 30 * MIN, incrementMs: 0,     category: 'classical' },
  { id: '30+20',label: 'Classical 30+20',initialMs: 30 * MIN, incrementMs: 20 * 1000, category: 'classical' }
];

const SYNC_GLITCH_MS = 5000;

const OPP = { w: 'b', b: 'w' };

export class Clock {
  constructor({
    initialMs,
    incrementMs = 0,
    onTick,
    onFlag,
    tickIntervalMs = 100,
    localColor = null
  } = {}) {
    this.initialMs = initialMs;
    this.incrementMs = incrementMs;
    this.onTick = typeof onTick === 'function' ? onTick : () => {};
    this.onFlag = typeof onFlag === 'function' ? onFlag : () => {};
    this.tickIntervalMs = tickIntervalMs;
    this.localColor = localColor;

    this.remaining = { w: initialMs, b: initialMs };
    this.active = null;
    this.lastTickAt = 0;

    this.timer = null;
    this.userStopped = true;
    this.autoPaused = false;
    this.flagged = null;

    this._onVisibility = null;
    this._installVisibility();
  }

  _installVisibility() {
    if (typeof document === 'undefined' || document == null) return;
    if (typeof document.addEventListener !== 'function') return;
    const handler = () => {
      if (typeof document.visibilityState !== 'string') return;
      if (document.visibilityState === 'hidden') {
        this.autoPaused = true;
        this._clearTimer();
      } else if (this.autoPaused) {
        this.autoPaused = false;
        if (!this.userStopped) this._startTimer();
      }
    };
    this._onVisibility = handler;
    try {
      document.addEventListener('visibilitychange', handler);
    } catch (_) {}
  }

  _clearTimer() {
    if (this.timer !== null) {
      try { clearInterval(this.timer); } catch (_) {}
      this.timer = null;
    }
  }

  _startTimer() {
    if (this.timer !== null) return;
    this.lastTickAt = performance.now();
    this.timer = setInterval(() => this._tick(), this.tickIntervalMs);
  }

  _snapshot() {
    return { w: this.remaining.w, b: this.remaining.b, active: this.active };
  }

  _liveRemaining(color) {
    const v = this.remaining[color];
    if (this.active === color && this.timer !== null) {
      const delta = performance.now() - this.lastTickAt;
      return v - delta;
    }
    return v;
  }

  _tick() {
    if (this.active === null) return;
    const now = performance.now();
    const delta = now - this.lastTickAt;
    this.lastTickAt = now;
    this.remaining[this.active] -= delta;
    if (this.remaining[this.active] <= 0) {
      this.remaining[this.active] = Math.min(0, this.remaining[this.active]);
      const fallen = this.active;
      this.active = null;
      this.flagged = fallen;
      this._clearTimer();
      try { this.onFlag(fallen); } catch (_) {}
      return;
    }
    try { this.onTick(this._snapshot()); } catch (_) {}
  }

  start() {
    this.userStopped = false;
    this.autoPaused = false;
    if (this.active !== null) this._startTimer();
    return this;
  }

  stop() {
    this.userStopped = true;
    this._clearTimer();
    return this;
  }

  getRemaining(color) {
    if (color !== 'w' && color !== 'b') return 0;
    return this._liveRemaining(color);
  }

  onMove(color) {
    if (color !== 'w' && color !== 'b') return this;
    this.remaining[color] += this.incrementMs;
    this.active = OPP[color];
    this.lastTickAt = performance.now();
    if (!this.userStopped && !this.autoPaused) this._startTimer();
    try { this.onTick(this._snapshot()); } catch (_) {}
    return this;
  }

  onRemoteSync(color, remainingMs) {
    if (color !== 'w' && color !== 'b') return;
    if (this.localColor !== null && color === this.localColor) return;
    if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)) return;
    if (remainingMs < 0) remainingMs = 0;
    const current = this.remaining[color];
    if (remainingMs < current) {
      this.remaining[color] = remainingMs;
      return;
    }
    if (remainingMs > current && (remainingMs - current) <= SYNC_GLITCH_MS) {
      this.remaining[color] = remainingMs;
    }
  }

  reset({ initialMs, incrementMs } = {}) {
    this._clearTimer();
    const nextInitial = typeof initialMs === 'number' ? initialMs : this.initialMs;
    const nextIncrement = typeof incrementMs === 'number' ? incrementMs : this.incrementMs;
    this.initialMs = nextInitial;
    this.incrementMs = nextIncrement;
    this.remaining = { w: nextInitial, b: nextInitial };
    this.active = null;
    this.flagged = null;
    this.lastTickAt = 0;
    this.userStopped = true;
    this.autoPaused = false;
    try { this.onTick(this._snapshot()); } catch (_) {}
    return this;
  }

  destroy() {
    this._clearTimer();
    if (this._onVisibility && typeof document !== 'undefined' && document != null) {
      try {
        document.removeEventListener('visibilitychange', this._onVisibility);
      } catch (_) {}
    }
    this._onVisibility = null;
    this.active = null;
  }
}
