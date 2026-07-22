const SCHEDULE = [
  4 * 3600 * 1000,
  24 * 3600 * 1000,
  3 * 24 * 3600 * 1000,
  7 * 24 * 3600 * 1000,
  14 * 24 * 3600 * 1000,
  30 * 24 * 3600 * 1000,
  90 * 24 * 3600 * 1000,
  180 * 24 * 3600 * 1000,
];

const STORAGE_KEY = 'chessright:srs';
const STREAK_KEY = 'chessright:srs:streak';
const MASTERY_LEVEL = 6;
const DAY_MS = 24 * 3600 * 1000;

function todayKey(ts) {
  const d = new Date(ts || Date.now());
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function daysBetween(a, b) {
  return Math.round((b - a) / DAY_MS);
}

function startOfDay(ts) {
  const d = new Date(ts || Date.now());
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class SRS {
  constructor() {
    this.records = this._loadRecords();
    this.streak = this._loadStreak();
  }

  _loadRecords() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  _saveRecords() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch (_) {}
  }

  _loadStreak() {
    try {
      const raw = localStorage.getItem(STREAK_KEY);
      if (!raw) return { count: 0, longest: 0, lastDay: '' };
      const parsed = JSON.parse(raw);
      return {
        count: parsed.count || 0,
        longest: parsed.longest || 0,
        lastDay: parsed.lastDay || '',
      };
    } catch (_) {
      return { count: 0, longest: 0, lastDay: '' };
    }
  }

  _saveStreak() {
    try {
      localStorage.setItem(STREAK_KEY, JSON.stringify(this.streak));
    } catch (_) {}
  }

  _key(lineId, fen, move) {
    return lineId + '|' + fen + '|' + move;
  }

  getRecord(lineId, fen, move) {
    return this.records[this._key(lineId, fen, move)] || null;
  }

  review(lineId, fen, move, correct) {
    const key = this._key(lineId, fen, move);
    const now = Date.now();
    const existing = this.records[key];
    let level = existing ? existing.level : 0;

    if (correct) {
      level = Math.min(SCHEDULE.length, level + 1);
    } else {
      level = 1;
    }

    const interval = SCHEDULE[level - 1] || SCHEDULE[0];
    const record = {
      lineId,
      fen,
      move,
      level,
      reviewedAt: now,
      dueAt: now + interval,
      correctCount: (existing ? existing.correctCount : 0) + (correct ? 1 : 0),
      wrongCount: (existing ? existing.wrongCount : 0) + (correct ? 0 : 1),
      repetitions: (existing ? existing.repetitions : 0) + 1,
    };
    this.records[key] = record;
    this._saveRecords();
    return record;
  }

  getDueItems() {
    const now = Date.now();
    return Object.values(this.records).filter((r) => r.dueAt <= now);
  }

  getDueCount() {
    return this.getDueItems().length;
  }

  getLineProgress(lineId) {
    const items = Object.values(this.records).filter((r) => r.lineId === lineId);
    if (!items.length) {
      return { total: 0, mastered: 0, avgLevel: 0 };
    }
    const mastered = items.filter((r) => r.level >= MASTERY_LEVEL).length;
    const sumLevel = items.reduce((s, r) => s + r.level, 0);
    return {
      total: items.length,
      mastered,
      avgLevel: sumLevel / items.length,
    };
  }

  getStats() {
    const all = Object.values(this.records);
    const total = all.length;
    const now = Date.now();
    const dueToday = all.filter((r) => r.dueAt <= now).length;
    const masteredCount = all.filter((r) => r.level >= MASTERY_LEVEL).length;
    const avgRetention = total
      ? all.reduce((s, r) => {
          const reps = r.correctCount + r.wrongCount;
          return s + (reps ? r.correctCount / reps : 0);
        }, 0) / total
      : 0;
    return { totalItems: total, dueToday, masteredCount, avgRetention };
  }

  getStreak() {
    return { ...this.streak };
  }

  recordReview() {
    const today = todayKey();
    if (this.streak.lastDay === today) {
      return this.streak;
    }
    const todayStart = startOfDay();
    let nextCount = 1;
    if (this.streak.lastDay) {
      const lastStart = startOfDay(new Date(this.streak.lastDay + 'T00:00:00').getTime());
      const gap = daysBetween(lastStart, todayStart);
      if (gap === 1) {
        nextCount = this.streak.count + 1;
      } else if (gap <= 0) {
        nextCount = Math.max(1, this.streak.count);
      }
    }
    this.streak = {
      count: nextCount,
      longest: Math.max(this.streak.longest, nextCount),
      lastDay: today,
    };
    this._saveStreak();
    return this.streak;
  }

  reset() {
    this.records = {};
    this.streak = { count: 0, longest: 0, lastDay: '' };
    this._saveRecords();
    this._saveStreak();
  }
}

export const SCHEDULE_INTERVALS = SCHEDULE;
export const MASTERY_THRESHOLD = MASTERY_LEVEL;
