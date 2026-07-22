export const DAY_MS = 86400000;
export const C_DECAY = 63.2;
export const RD_MIN = 30;
export const RD_MAX = 350;
export const RD_DEFAULT_OPP = 50;

export function decayRd(rd, lastGameAt, now) {
  const base = Math.min(RD_MAX, Math.max(RD_MIN, rd));
  if (!lastGameAt) return base;
  const days = Math.max(0, (now - lastGameAt) / DAY_MS);
  const grown = Math.sqrt(base * base + C_DECAY * C_DECAY * days);
  if (grown < RD_MIN) return RD_MIN;
  if (grown > RD_MAX) return RD_MAX;
  return grown;
}

export function glickoUpdate(rating, rd, oppRating, oppRd, score) {
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

export function scoreFromResult(result) {
  if (result === 'win') return 1;
  if (result === 'loss') return 0;
  return 0.5;
}

export async function applyResultToUser(db, userRow, opponentRating, result, now) {
  const oppRating = opponentRating == null ? userRow.rating : opponentRating;
  const oppRd = RD_DEFAULT_OPP;
  const decayed = decayRd(userRow.rating_rd, userRow.last_game_at, now);
  const { rating, rd } = glickoUpdate(userRow.rating, decayed, oppRating, oppRd, scoreFromResult(result));
  const newRating = Math.round(rating);
  const newRd = Math.round(rd);
  const gamesPlayed = (userRow.games_played || 0) + 1;
  const wins = (userRow.wins || 0) + (result === 'win' ? 1 : 0);
  const losses = (userRow.losses || 0) + (result === 'loss' ? 1 : 0);
  const draws = (userRow.draws || 0) + (result === 'draw' ? 1 : 0);
  await db.prepare(
    'UPDATE users SET rating = ?, rating_rd = ?, games_played = ?, wins = ?, losses = ?, draws = ?, last_game_at = ? WHERE id = ?'
  ).bind(newRating, newRd, gamesPlayed, wins, losses, draws, now, userRow.id).run();
  return {
    id: userRow.id,
    rating: newRating,
    rating_rd: newRd,
    games_played: gamesPlayed,
    wins, losses, draws,
    last_game_at: now
  };
}
