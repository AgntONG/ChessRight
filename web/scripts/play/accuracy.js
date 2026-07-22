const WP_K = 0.00368208;
const CP_CAP = 1500;
const NEAR_BEST_CP = 10;
const MATE_CP_VALUE = 1000;
const MATE_PER_PLY_PENALTY = 10;

export function winProbability(cp) {
  const c = Math.max(-CP_CAP, Math.min(CP_CAP, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-WP_K * c)) - 1);
}

export function moveAccuracy({ cpBefore, cpAfter, cpBest, mateBefore, mateAfter, mateBest }) {
  const hadMate = mateBefore != null || mateBest != null || mateAfter != null;

  if (hadMate) {
    return mateAccuracy({ mateBefore, mateAfter, mateBest });
  }

  if (cpBest != null && cpAfter != null && (cpBest - cpAfter) < NEAR_BEST_CP) {
    return 100;
  }

  const before = cpBefore ?? cpBest ?? 0;
  const after = cpAfter ?? 0;
  const winBefore = winProbability(before);
  const winAfter = winProbability(after);
  const drop = Math.max(0, winBefore - winAfter);
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

function mateAccuracy({ mateBefore, mateAfter, mateBest }) {
  if (mateBest != null && mateAfter != null && Math.sign(mateBest) === Math.sign(mateAfter) && Math.abs(mateAfter) <= Math.abs(mateBest)) {
    return 100;
  }

  if (mateBest != null && mateBest > 0) {
    if (mateAfter == null || mateAfter <= 0) {
      return Math.max(0, 100 - MATE_PER_PLY_PENALTY * Math.abs(mateBest));
    }
    const squandered = Math.abs(mateAfter) - Math.abs(mateBest);
    return Math.max(0, 100 - MATE_PER_PLY_PENALTY * squandered);
  }

  if (mateBefore != null && mateBefore < 0) {
    return 92;
  }

  return 88;
}

const BUCKET_ORDER = ['brilliant', 'great', 'good', 'inaccuracy', 'mistake', 'blunder'];

function classifyMove({ cpLoss, isBrilliant }) {
  if (isBrilliant) return 'brilliant';
  if (cpLoss <= 10) return 'great';
  if (cpLoss <= 25) return 'good';
  if (cpLoss <= 50) return 'inaccuracy';
  if (cpLoss <= 100) return 'mistake';
  return 'blunder';
}

function detectBrilliant({ cpBefore, cpAfter, cpBest, playerColor }) {
  if (cpBefore != null && Math.abs(cpBefore) >= 200 && Math.sign(cpBefore) === (playerColor === 'w' ? 1 : -1)) {
    return false;
  }

  if (cpBest == null || cpAfter == null) return false;
  if (cpBest - cpAfter > 20) return false;

  return cpBefore != null && cpAfter < cpBefore - 50 && cpAfter > cpBefore - 1000;
}

export function accuracyToElo(accuracy) {
  const a = Math.max(50, Math.min(100, accuracy));
  const t = (a - 50) / 50;
  const elo = 800 + 2000 / (1 + Math.exp(-6 * (t - 0.5)));
  return Math.round(Math.max(400, Math.min(2800, elo)));
}

export function averageCpLoss(moveData) {
  const losses = moveData
    .filter(m => m.cpBest != null && m.cpAfter != null && m.mateBest == null && m.mateAfter == null)
    .map(m => Math.max(0, m.cpBest - m.cpAfter));
  if (losses.length === 0) return 0;
  return losses.reduce((a, b) => a + b, 0) / losses.length;
}

export function accuracyBuckets(moveData) {
  const buckets = { brilliant: 0, great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const m of moveData) {
    const isBrilliant = detectBrilliant(m);
    const cpLoss = m.cpBest != null && m.cpAfter != null ? Math.max(0, m.cpBest - m.cpAfter) : 0;
    const cls = classifyMove({ cpLoss, isBrilliant });
    buckets[cls]++;
  }
  return buckets;
}

export function analyzeGame(moveData) {
  if (!Array.isArray(moveData) || moveData.length === 0) {
    return {
      accuracy: 0,
      estimatedElo: 400,
      averageCpLoss: 0,
      buckets: { brilliant: 0, great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 },
      perMove: []
    };
  }

  const perMove = moveData.map(m => {
    const accuracy = moveAccuracy(m);
    const isBrilliant = detectBrilliant(m);
    const cpLoss = m.cpBest != null && m.cpAfter != null && m.mateBest == null && m.mateAfter == null
      ? Math.max(0, m.cpBest - m.cpAfter)
      : 0;
    const classification = classifyMove({ cpLoss, isBrilliant });
    return { san: m.san, accuracy, cpLoss, classification, isBrilliant };
  });

  const validAccuracies = perMove.map(p => p.accuracy).filter(a => !Number.isNaN(a));
  const accuracy = validAccuracies.length > 0
    ? validAccuracies.reduce((a, b) => a + b, 0) / validAccuracies.length
    : 0;

  const buckets = { brilliant: 0, great: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const p of perMove) buckets[p.classification]++;

  return {
    accuracy: Math.round(accuracy * 10) / 10,
    estimatedElo: accuracyToElo(accuracy),
    averageCpLoss: Math.round(averageCpLoss(moveData) * 10) / 10,
    buckets,
    perMove
  };
}

export const BUCKETS = BUCKET_ORDER;
