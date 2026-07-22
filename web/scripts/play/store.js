const ADJ = [
  'Swift', 'Crimson', 'Iron', 'Brave', 'Silent', 'Shadow', 'Golden', 'Silver',
  'Steel', 'Furious', 'Mighty', 'Wise', 'Noble', 'Fierce', 'Cold', 'Dark',
  'Bright', 'Storm', 'Thunder', 'Royal', 'Savage', 'Phantom', 'Hidden', 'Proud',
  'Wild', 'Bold', 'Cunning', 'Valiant', 'Stealthy', 'Relentless'
];

const NOUN = [
  'Falcon', 'Knight', 'Bishop', 'Rook', 'Pawn', 'King', 'Queen', 'Tiger',
  'Wolf', 'Eagle', 'Hawk', 'Lion', 'Panther', 'Fox', 'Owl', 'Bear',
  'Cobra', 'Mamba', 'Shark', 'Dragon', 'Phoenix', 'Raven', 'Sparrow', 'Stallion',
  'Viper', 'Scorpion', 'Rhino', 'Bison', 'Jaguar', 'Leopard'
];

const KEY_USER = 'chessright:user';
const KEY_GAMES = 'chessright:games';
const KEY_IDX = 'chessright:games:idx';

const DAY_MS = 86400000;
const C_DECAY = 63.2;
const RD_MIN = 30;
const RD_MAX = 350;
const RD_DEFAULT_OPP = 50;
const GAMES_CAP = 500;

function lsGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function lsSet(key, val) {
  try { localStorage.setItem(key, val); return true; } catch { return false; }
}

function lsDel(key) {
  try { localStorage.removeItem(key); } catch {}
}

function randomHandle() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  return a + n;
}

function genId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  const num = BigInt('0x' + hex);
  return prefix + num.toString(36);
}

function readUser() {
  const raw = lsGet(KEY_USER);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function writeUser(u) {
  lsSet(KEY_USER, JSON.stringify(u));
}

function readGames() {
  const raw = lsGet(KEY_GAMES);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}

function writeGames(arr) {
  lsSet(KEY_GAMES, JSON.stringify(arr));
}

function readIdx() {
  const raw = lsGet(KEY_IDX);
  if (raw == null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function bumpIdx() {
  const n = readIdx() + 1;
  lsSet(KEY_IDX, String(n));
  return n;
}

function decayRd(rd, lastGameAt, now) {
  const base = Math.min(RD_MAX, Math.max(RD_MIN, rd));
  if (!lastGameAt) return base;
  const days = Math.max(0, (now - lastGameAt) / DAY_MS);
  const grown = Math.sqrt(base * base + C_DECAY * C_DECAY * days);
  if (grown < RD_MIN) return RD_MIN;
  if (grown > RD_MAX) return RD_MAX;
  return grown;
}

function glickoUpdate(rating, rd, oppRating, oppRd, score) {
  const q = Math.log(10) / 400;
  const g = (rdv) => 1 / Math.sqrt(1 + (3 * q * q * rdv * rdv) / (Math.PI * Math.PI));
  const gOpp = g(oppRd);
  const e = 1 / (1 + Math.pow(10, (-gOpp * (rating - oppRating)) / 400));
  const d2 = 1 / (q * q * gOpp * gOpp * e * (1 - e));
  const denom = 1 / (rd * rd) + 1 / d2;
  const newRating = rating + (q / denom) * gOpp * (score - e);
  let newRd = Math.sqrt(1 / denom);
  if (newRd < RD_MIN) newRd = RD_MIN;
  if (newRd > RD_MAX) newRd = RD_MAX;
  return { rating: newRating, rd: newRd };
}

export const store = {
  getUser() {
    return readUser();
  },

  ensureUser() {
    const existing = readUser();
    if (existing) return existing;
    const now = Date.now();
    const u = {
      id: genId('usr_'),
      token: genId('tok_'),
      handle: randomHandle(),
      createdAt: now,
      rating: 1200,
      ratingVolatility: RD_MAX,
      gamesPlayed: 0,
      estimatedElo: null,
      lastSync: null,
      lastGameAt: null
    };
    writeUser(u);
    return u;
  },

  updateRating(delta, opponentRating, result) {
    const u = readUser() || this.ensureUser();
    const now = Date.now();
    const score = result === 'win' ? 1 : result === 'loss' ? 0 : 0.5;
    const decayedRd = decayRd(u.ratingVolatility, u.lastGameAt, now);
    const { rating, rd } = glickoUpdate(
      u.rating,
      decayedRd,
      opponentRating,
      RD_DEFAULT_OPP,
      score
    );
    u.rating = rating + delta;
    u.ratingVolatility = rd;
    u.gamesPlayed = (u.gamesPlayed || 0) + 1;
    u.lastGameAt = now;
    writeUser(u);
    return u;
  },

  setEstimatedElo(elo) {
    const u = readUser() || this.ensureUser();
    u.estimatedElo = elo;
    writeUser(u);
  },

  saveGame(game) {
    const u = readUser() || this.ensureUser();
    const g = Object.assign({}, game);
    if (!g.id) g.id = genId('gme_');
    if (!g.userId) g.userId = u.id;
    const games = readGames();
    games.push(g);
    if (games.length > GAMES_CAP) {
      games.splice(0, games.length - GAMES_CAP);
    }
    writeGames(games);
    bumpIdx();
    return g;
  },

  getGames(opts) {
    const o = opts || {};
    const limit = o.limit;
    const offset = o.offset || 0;
    const result = o.result;
    let games = readGames();
    if (result) games = games.filter((g) => g.result === result);
    games = games.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (offset) games = games.slice(offset);
    if (limit != null && limit >= 0) games = games.slice(0, limit);
    return games;
  },

  getGame(id) {
    if (!id) return null;
    const games = readGames();
    return games.find((g) => g.id === id) || null;
  },

  getStats() {
    const games = readGames()
      .slice()
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    let wins = 0;
    let losses = 0;
    let draws = 0;
    let accSum = 0;
    let accCount = 0;
    let cpSum = 0;
    let cpCount = 0;
    let lastPlayedAt = null;
    for (const g of games) {
      if (g.result === 'win') wins++;
      else if (g.result === 'loss') losses++;
      else if (g.result === 'draw') draws++;
      if (typeof g.accuracy === 'number' && isFinite(g.accuracy)) {
        accSum += g.accuracy;
        accCount++;
      }
      if (Array.isArray(g.moves)) {
        for (const m of g.moves) {
          if (m && typeof m.lateness === 'number' && isFinite(m.lateness)) {
            cpSum += m.lateness;
            cpCount++;
          }
        }
      }
      const ts = g.endedAt != null ? g.endedAt : g.startedAt;
      if (ts != null && (lastPlayedAt == null || ts > lastPlayedAt)) {
        lastPlayedAt = ts;
      }
    }
    const n = games.length;
    let currentStreak = 0;
    if (n > 0) {
      const last = games[n - 1];
      if (last.result === 'win' || last.result === 'loss') {
        const sign = last.result === 'win' ? 1 : -1;
        let i = n - 1;
        while (i >= 0 && games[i].result === last.result) {
          currentStreak += sign;
          i--;
        }
      }
    }
    let bestStreak = 0;
    let run = 0;
    for (const g of games) {
      if (g.result === 'win') {
        run++;
        if (run > bestStreak) bestStreak = run;
      } else {
        run = 0;
      }
    }
    return {
      gamesPlayed: n,
      wins,
      losses,
      draws,
      currentStreak,
      bestStreak,
      averageAccuracy: accCount ? accSum / accCount : 0,
      averageCpLoss: cpCount ? cpSum / cpCount : 0,
      lastPlayedAt
    };
  },

  async syncToServer() {
    return { synced: 0 };
  },

  clearAll() {
    lsDel(KEY_USER);
    lsDel(KEY_GAMES);
    lsDel(KEY_IDX);
  },

  exportData() {
    return JSON.stringify({
      user: readUser(),
      games: readGames(),
      exportedAt: Date.now()
    });
  }
};
