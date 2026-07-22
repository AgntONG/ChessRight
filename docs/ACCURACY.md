# Accuracy and rating math

This document specifies the math behind ChessRight's two rating signals: the per-game accuracy / estimated strength shown in the post-game report, and the Glicko-1 live rating shown on your profile. It exists so the numbers on screen are not magic — they have a derivation, a rationale, and known limitations.

Implementations live in two pure places: `web/scripts/play/accuracy.js` (per-game, accuracy + estimated ELO) and the Glicko-1 section of `web/scripts/play/store.js` (cross-game rating). Those files are the source of truth for the constants; this document explains why those constants were chosen and what the formulas mean.

## 1. Why centipawn loss is not enough

The naive way to score a move is to ask Stockfish how much evaluation it lost, in centipawns (1 pawn = 100cp):

> You played a move that was 300cp worse than the engine's best move, so that was a 300cp blunder.

This collapses on contact with reality. A 300cp blunder in a position where you are already +5 leaves you at +2 — still completely winning, and the move did not matter. The same 300cp blunder in an equal position turns 0.0 into -3, which is essentially lost. The same number, opposite meanings.

To compare moves across radically different positions we need a currency that absorbs the position's prior state. That currency is **win probability**: convert every evaluation to "what fraction of the time does the side to move win from here?", then measure the move's damage in probability space. A blunder in a winning position barely moves win probability; the same blunder in an equal position is devastating. That matches intuition.

## 2. The win-probability model

Lichess fit a logistic curve to millions of rated games, regressing game outcome against the engine evaluation before the deciding move. The published relationship, given a centipawn evaluation `cp` from the side-to-move's perspective, is:

```
W(cp) = 50 + 50 * ( 2 / (1 + exp(-0.00368208 * cp)) - 1 )
```

A few reference points:

| `cp` (centipawns) | `W(cp)` (win %) |
|---:|---:|
| -1500 | ~0.8 |
| -300  | ~17  |
| -100  | ~43  |
| 0     | 50  |
| +100  | ~57  |
| +300  | ~83  |
| +1000 | ~99.5 |
| +1500 | ~99.2 |

Notes:

- The constant `0.00368208` is empirical — it is the slope Lichess obtained by fitting. We use it verbatim; the fitted curve is what people mean when they say "Lichess accuracy."
- The expression inside the parentheses is a logistic centered at zero, scaled to `[-1, +1]`. The outer `50 + 50 * ...` remaps to `[0, 100]` percent.
- This is from the **side-to-move's** perspective. To get the opponent's win probability for the same position, negate `cp` and re-evaluate, or equivalently compute `100 - W(cp)` (treating draws as half-wins, which the Lichess fit implicitly does).
- Inputs are clamped to `[-1500, +1500]`. Beyond ±15 pawns the game is decided; the exact magnitude no longer matters and the curve would otherwise report differences in the fourth decimal of probability.

Forced mates are mapped into the centipawn domain before this formula is applied: a mate-in-N is converted to `cp = 10000 - 100*N` (positive) or `cp = -10000 + 100*N` (negative), which clamps to the ±1500 cap. This means "mate in 3" and "mate in 7" are both effectively +1500cp — fully winning — which is correct: a forced mate is a forced mate regardless of length.

## 3. Per-move accuracy

For each player move we have three win probabilities:

- `W_before` — win probability before the opponent's previous move settled, i.e. what the player had to work with at the start of their turn (equivalently: the probability of the position the engine was asked to analyze).
- `W_best` — win probability of the engine's best move.
- `W_after` — win probability of the move the player actually made.

`W_after - W_before` is the win-probability lost by choosing the actual move over the position's promise. Lichess's accuracy formula is an exponential decay on this loss:

```
accuracy = 103.1668 * exp(-0.04354 * (W_before - W_after)) - 3.1669
```

Properties:

- Perfect play (`W_after = W_before`) gives `accuracy ≈ 100`.
- A drop of 10 percentage points (e.g. 80% → 70%) gives `accuracy ≈ 95.6`.
- A drop of 50 percentage points (e.g. 80% → 30%) gives `accuracy ≈ 69.5`.
- As the loss grows without bound, accuracy decays toward `-3.1669`. In practice we clamp the final per-move accuracy to `[0, 100]`.

The constants `103.1668`, `-0.04354`, and `-3.1669` are Lichess's fit constants. They were chosen so that accuracy matches human intuition across rating levels: a 2500 player's average accuracy lands near 95, a 1500 player's near 85, a 1000 player's near 70.

**Special cases:**

- *Near-best moves.* If `W_after` is within 0.5 percentage points of `W_best`, we short-circuit and return 100. This avoids penalizing the player for choosing between engine-equal options (e.g. two perfectly fine recaptures).
- *Forced moves.* If only one legal move exists, accuracy is 100 by definition — no decision was made.
- *No previous move.* The first move of the game has no `W_before`; it is excluded from the average.

## 4. Game-average accuracy

The simplest reasonable aggregation:

```
game_accuracy = mean(per_move_accuracy for each move where accuracy was computed)
```

**Known limitation: this is unweighted.** A blunder in a dead-lost endgame counts exactly as much as a blunder in a complex middlegame where it actually decided the result. Lichess weights moves by position importance (closer to 50% win probability = higher weight, because those moves swing the game more). The unweighted mean is a reasonable approximation for a hobby project — it correlates strongly with the weighted version for typical games — and is dramatically simpler to implement and reason about. We document this as a tradeoff, not a defect.

## 5. From accuracy to estimated ELO

Per-game accuracy is satisfying but not directly comparable to a rating. To translate it into an ELO-like number we fit a sigmoid to anchor points Lichess has published for blitz:

| Source                       | Accuracy | Approx ELO |
|------------------------------|---------:|-----------:|
| Lichess published correlation | 95%      | 2200       |
|                              | 85%      | 1700       |
|                              | 70%      | 1200       |

We use a logistic in a normalized accuracy variable:

```
t   = (accuracy - 50) / 50          # normalized to roughly [0, 1]
elo = 800 + 2000 / (1 + exp(-6 * (t - 0.5)))
```

Evaluating at our intended anchors:

| `accuracy` | `t`   | Estimated ELO |
|-----------:|------:|--------------:|
| 50%        | 0.0   | ~895          |
| 75%        | 0.5   | ~1800         |
| 95%        | 0.9   | ~2300         |
| 100%       | 1.0   | ~2704         |

The final value is clamped to `[400, 2800]`. The lower bound prevents a single catastrophic game from reporting "you played at 50 ELO"; the upper bound prevents a flawless game against a weak bot from inflating past human grandmaster level.

These anchors are intentionally approximate. The relationship between accuracy and rating is not a single curve — it depends on time control, opening repertoire, and opponent strength — so the output is labeled **estimated strength**, not "your rating." Its job is to give immediate, per-game feedback, complementing the slow-converging live rating.

## 6. Live rating vs estimated strength

ChessRight shows two numbers because they answer different questions.

| Signal | Source | Converges | Reflects | Authority |
|---|---|---|---|---|
| **Live rating** | Glicko-1 over game results | Slowly, over many games | Did you win, lose, or draw? | Computed and stored locally in the browser; not a credential |
| **Estimated strength** | Win-probability accuracy per game | Immediately, after one game | How well did you play, independent of result? | Computed locally, not trusted for rankings |

Why both? You can play brilliantly and lose — a single tactical shot you missed in an otherwise strong game, or a winning position you blundered at move 40 after outplaying them for 39 moves. Live rating records the loss; estimated strength records the brilliance. Together they tell a fuller story than either alone.

**The mismatch is diagnostic, not noise:**

- *Estimated > live:* you are playing better than your results. Likely causes: tough opponents (your accuracy is high but you still lose), bad luck in won positions, or a small sample size where Glicko's RD is still wide.
- *Live > estimated:* your results are outperforming your move quality. Likely causes: weak opponents inflating your win rate, opponents blundering more than you, or you are due for a regression as the rating catches up.

A player improving fast often sees estimated strength climb weeks before their live rating does. Watching both is more informative than watching either.

## 7. Glicko-1 (results rating)

The live rating uses Glicko-1, Mark Glickman's improvement on Elo. The core insight is that a rating is meaningless without an attached uncertainty. A player with 50 rated games at 1800 is meaningfully stronger than a brand-new player provisionally rated 1800.

In the current frontend-only build the rating is computed and stored locally; the math is unchanged from the earlier server-side design and the formulas below are identical.

### State

Every player has two numbers stored in their local profile:

- `rating` — current best estimate (default `1200`)
- `rating_rd` — rating deviation, the standard-error-like uncertainty (default `350`, the maximum)

New players start at `1200 ± 350` — essentially "we know nothing beyond 'somewhere between 500 and 1900'." Each played game shrinks RD; inactivity grows it back toward 350.

### RD decay over inactivity

Between games, RD grows toward the cap `RD_MAX = 350`. From `web/scripts/play/store.js`:

```
new_rd = sqrt(rd^2 + c^2 * t)
```

where `t` is days since last game and `c = 63.2` is a constant chosen so that RD grows from a typical active value (50) to the cap (350) in roughly 100 inactive days. This is Glickman's formula; the constant comes from inverting the desired decay rate.

### Update equations

Given a player `(rating, rd)` and an opponent `(opp_rating, opp_rd)`, with score `s ∈ {1, 0.5, 0}` (win/draw/loss):

```
q       = ln(10) / 400
g(rd)   = 1 / sqrt(1 + 3*q^2*rd^2 / pi^2)
E       = 1 / (1 + 10^(-g(opp_rd) * (rating - opp_rating) / 400))
d^2     = 1 / (q^2 * g(opp_rd)^2 * E * (1 - E))

new_rating = rating + (q / (1/rd^2 + 1/d^2)) * g(opp_rd) * (s - E)
new_rd     = sqrt(1 / (1/rd^2 + 1/d^2))
```

These are Glickman's published equations (see *A Comprehensive Guide to Chess Ratings*, Glickman 2013, on his BU page). Both sides' updates are symmetric: each player sees the other as the opponent and runs the same formula with their own `s` (1 for one side, 0 for the other, 0.5 each for a draw).

Implementation notes from `web/scripts/play/store.js`:

- `RD_MIN = 30`. After many games RD would otherwise collapse toward zero, making the rating nearly unchangeable. We floor it at 30 so ratings stay responsive even for very active players.
- `RD_MAX = 350`. Ceiling matches Glickman's recommended maximum.
- Opponent RD defaults to `50` when not known (e.g. bot games), per `RD_DEFAULT_OPP`.
- The score is derived from the result string in `scoreFromResult`: `win → 1`, `loss → 0`, `draw → 0.5`.

### Why Glicko-1 and not Elo or Glicko-2?

- *Not Elo* because Elo has no notion of uncertainty. A new player's first 10 results swing their rating wildly, and opponents beating a new player gain/lose credit as though the rating were reliable. Glicko-1 fixes this by weighting updates by both RDs.
- *Not Glicko-2* because Glicko-2 adds a volatility parameter and a system "tau" that requires periodic re-evaluation across the whole population. For a hobby site's game volume it produces nearly identical ratings at materially more implementation and operational complexity. Glicko-1 is the right tool.

## 8. Implementation

Both rating computations are deliberately isolated:

- **`web/scripts/play/accuracy.js`** — pure functions: `winProbability(cp)`, `moveAccuracy(wBefore, wAfter)`, `gameAccuracy(moves)`, `estimatedElo(accuracy)`. No DOM, no I/O, no dependencies. Directly unit-testable with `node --test` and a handful of edge cases.
- **`web/scripts/play/store.js`** — pure functions for the Glicko-1 math (`decayRd`, `glickoUpdate`) embedded in the persistence module, plus `store.updateRating()`, the entry point the game controller calls after a finished game to refresh the local profile.

The split keeps the math testable and the I/O boring. If analysis ever moves server-side (e.g. to support anti-cheat or recompute on deeper Stockfish), only `accuracy.js` needs to run there — its purity makes that trivial.

## 9. Limitations and future work

The numbers are useful, not oracular. Known caveats:

- **Stockfish depth affects accuracy.** A move judged "best" at depth 15 may be revealed as a subtle error at depth 30. v1 uses depth 15–18; deeper analysis would reclassify a non-trivial fraction of moves and shift some accuracies by a few points. The post-game report always reflects the depth the client used.
- **Opening moves are nearly free.** In book positions many moves are engine-equal, so accuracy is high regardless of skill. A 1200 player and a 2400 player both score ~100% accuracy on the first 8 moves of most games. This biases game-average accuracy upward; weighted averaging (section 4) would partially address it.
- **Time pressure is ignored.** A blunder made with 5 seconds on the clock is weighted identically to one made with 5 minutes. A future improvement would weight moves by time consumed or remaining clock.
- **No opening-aware scoring.** Theory shifts over time and across levels; we do not currently distinguish opening inaccuracy from middlegame inaccuracy.
- **Bot-game estimated strength is lenient.** Bots at low skill levels play suboptimal moves that inflate the player's accuracy. Live rating already handles this via opponent RD, but estimated strength does not.
- **The accuracy → ELO curve is a single fit.** It is calibrated to blitz anchors. Bullet and classical games likely need different curves; we ship one for simplicity and label the result "estimated."

Planned future work, in rough priority order:

1. Weighted averaging by position importance (move closer to 50% win probability counts more).
2. Time-aware per-move weighting.
3. Per-time-control estimated-strength curves.
4. Optional deeper re-analysis for finished games.

If you want to dig into the source, start at `web/scripts/play/accuracy.js` for the per-game math and `web/scripts/play/store.js` for the cross-game rating math. The functions are named after the formulas above, and the constants are the same ones cited here.
