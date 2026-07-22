# Architecture

This document describes how ChessRight's components fit together, what each one owns, how a typical game flows through the system, where it fails, and how it handles the constraints of its host platform.

If you only have time for one diagram, this is it.

```
Browser                          Cloudflare Edge              Peer
┌────────────────┐              ┌──────────────┐            ┌────────┐
│ Pages frontend │ ──REST─────► │ Worker (Hono)│            │ Browser│
│  landing       │              │  /api/auth   │            │ (peer) │
│  play.html     │ ◄─long-poll─ │  /api/match  │            └───┬────┘
│  account       │              │  /api/games  │                │
│                │              │  D1 + D.O.   │                │
│ Stockfish WASM │              └──────┬───────┘                │
│ (Web Worker)   │                     │                        │
│                │                     │ signaling              │
│ PeerJS client  │ ◄────WebRTC data channel─────────────────►   │
└────────────────┘                                              │
```

The Worker's job is narrow: anonymous auth, matchmaking coordination, and persistence. Everything that is hot path during a game — move exchange, clock, legality — runs client-side and peer-to-peer. This is the single most important design choice in the system, and it is what lets the whole thing fit on the Cloudflare free tier.

## Component responsibilities

### Frontend pages

- **`index.html` (landing).** The marketing front door. The signature element is the "brilliant move" animation in `landing.js`: a single tactical sequence rendered on a custom canvas-style board, sequenced against audio. Its only role is to make visitors click Play.
- **`play.html` (game client).** Everything that happens during a session: lobby (bot, ranked, invite, casual), board interaction, clocks, post-game analysis. The `scripts/play/` modules below collaborate to drive this page.
- **`account.html`.** Profile (handle, rating, RD), game history with replay, and the top-100 leaderboard. Pulls from `/api/users/me`, `/api/games`, and `/api/leaderboard`.

### `scripts/play/main.js` — game controller

The orchestrator. Wires together the board, the engine, the network client, the clock, and the local store into a state machine: `lobby → in-game (playing) → ended (analysis)`. Owns the canonical move list during play. Coordinates teardown when a game ends or the opponent disconnects.

### `scripts/play/board.js` — custom board renderer

A self-contained board built from scratch rather than pulled from a library. Pieces are absolutely positioned; movement is animated with CSS transforms (GPU-composited `translate`) so reflows are avoided during drag and animation. The interaction model (click-to-select, drag-to-move, drop-highlighting of legal targets) is reused from the landing-page brilliancy animation — same primitives, different driver. The board is purely presentational: it does not own move legality, that lives in chess.js.

### `scripts/play/engine.js` — Stockfish WASM wrapper

Owns the lifecycle of the Stockfish Web Worker: loading the vendored `assets/stockfish/*.wasm`, falling back to the jsdelivr CDN if the local file fails, posting UCI commands (`position`, `go`, `setoption`), and parsing `info depth ... cp ... pv ...` lines back into structured evaluations. Skill level maps linearly across 20 steps to a 1320–3190 ELO range. Engine failure is non-fatal — see [Failure modes](#failure-modes--fallbacks).

### `scripts/play/accuracy.js` — accuracy and estimated ELO

Pure, stateless functions that turn a list of (eval-before, eval-after) pairs into per-move accuracies, a game-average accuracy, and an estimated ELO. This is the heart of the post-game report and is fully specified in [ACCURACY.md](ACCURACY.md). It has no DOM and no I/O — it is callable from tests and from the Worker if we ever move analysis server-side.

### `scripts/play/store.js` — offline-first persistence

Writes profile, ratings, and finished games to `localStorage` immediately and queues a sync to the Worker when network is available. This is what makes ChessRight usable on a flaky connection: you can finish a bot game offline and your local rating updates instantly, then the game record syncs when you reconnect. Rated P2P games require the Worker for both matching and result submission, so they are not playable offline — only bot and casual games are.

### `scripts/play/net.js` — matchmaking and peer transport

Two distinct responsibilities in one module:

- `MatchClient` — REST client over `fetch` for `/api/match/queue`, `/api/match/poll`, `/api/match/leave`, and `/api/invite/*`. Long-polls the queue for a match assignment.
- `PeerConnection` — wraps the PeerJS data channel. Once the queue returns both peer IDs, this layer takes over: it opens the channel, sends/receives move messages, and signals disconnects back to the controller.

The boundary between these two is the moment matchmaking ends and gameplay begins. The Worker hands off and steps out.

### `scripts/play/clock.js` — chess clocks

Increment chess clocks (think `3+2`, `5+0`, `10+0`). Each side has a remaining-time counter that ticks on an interval and an increment added after each completed move. Critically, the clock **pauses** when the tab loses focus (`document.visibilitychange`) and **resumes** on focus — otherwise background-tab throttling would silently steal a player's time.

### Worker router — `worker/src/index.js`

Hono app exposing the REST surface. Routes (all under `/api`):

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/anonymous` | `POST` | Mint or refresh an anonymous HMAC token. |
| `/api/users/me` | `GET` | Current profile (rating, RD, record). |
| `/api/match/queue` | `POST` | Enter the matchmaking queue. |
| `/api/match/poll` | `GET` | Long-poll for a match assignment. |
| `/api/match/leave` | `POST` | Withdraw from the queue. |
| `/api/invite` | `POST` / `GET` | Create or redeem a 6-char invite code. |
| `/api/games` | `POST` / `GET` | Submit a finished game; list history. |
| `/api/leaderboard` | `GET` | Top-100 by rating. |

The router is thin: it parses requests, calls into the relevant module (`auth.js`, `games.js`, `leaderboard.js`, `elo.js`), and serializes the result. Business logic lives in those modules.

### D1 schema — `worker/schema.sql`

Three tables:

- **`users`** — `id`, `handle`, Glicko-1 `rating` + `rating_rd`, W/L/D counts, timestamps. Indexed by `rating DESC` for leaderboard.
- **`games`** — one row per finished game per player. Stores PGN, move list JSON, accuracy, estimated ELO, accuracy buckets, result, ending type, duration, and a `hash` that both clients must agree on (see [Security model](#security-model)). Uniqueness on `(user_id, hash)` makes duplicate submissions idempotent.
- **`invites`** — 6-char codes pointing at the creator's peer ID and rating, with an optional time control. Auto-expires when taken.

### `MatchQueue` Durable Object — `worker/src/queue.js`

A single Durable Object is the entire matchmaking coordinator. Why a DO and not plain D1 or KV?

- **Single-threaded coordination.** Two players must not be matched to the same opponent. A DO gives a single-threaded inbox per object ID, so we can pop a waiting player and assign a new one without races. With D1 + naive `SELECT FOR UPDATE` semantics you would have to think hard about concurrent transactions; the DO sidesteps the problem entirely.
- **In-memory state.** The queue is transient: it is fine to lose on a restart. A DO's in-memory storage is fast and free of read/write billing while the DO is alive.
- **Long-polling home.** The DO is the natural place to hold a `waitUntil` for the long-poll request, pair the requester, and respond when a match appears.

The queue stores waiting players keyed by time control + rating band. On a new enqueue, the DO scans for a compatible partner (within an expanding rating window as time-on-queue grows); if none, the requester parks and the next compatible enqueue pairs with them.

## Data flow: a typical ranked game

1. **Open `play.html`.** The controller boots, loads `store.js` (profile + queued syncs), and connects to the engine. User clicks **Find match**.
2. **Enter queue.** `net.js` POSTs to `/api/match/queue` with the user's token, rating, and time control. The Worker routes the request to the `MatchQueue` DO, which parks the player.
3. **Long-poll.** `net.js` GETs `/api/match/poll` on a loop (each request capped under 25s to fit the Worker wall-clock limit). The DO holds the request open until either a partner is found or the poll expires.
4. **Matched.** The DO returns both peer IDs, both ratings, a color assignment, and a shared game ID. Both clients receive this payload and transition to `in-game`.
5. **P2P connection.** Each client opens a PeerJS connection to the other's peer ID. The Worker is now out of the live path.
6. **Move exchange.** Each move goes over the data channel: `{type: 'move', from, to, promotion, clockAfter}`. Both clients run the move through chess.js locally, redraw the board, swap the clock.
7. **Game ends.** A terminal condition (checkmate, stalemate, resignation, timeout, draw agreement) is detected on both sides. Each client independently computes its own move list, accuracy, and a hash of the final position history.
8. **Submit.** Both clients POST `/api/games` with their perspective of the result, the PGN, and the hash. The Worker applies the Glicko-1 update for each player and stores the row. The `(user_id, hash)` uniqueness constraint dedupes if one client retries.
9. **Leaderboard.** The next `/api/leaderboard` request reflects the new ratings — within 60 seconds, when the cached response expires.

## Failure modes & fallbacks

| Failure | Detection | Fallback |
|---|---|---|
| Worker unreachable | `fetch` rejects or times out | Offline mode: bot and casual games still work; rated games are blocked with a toast. Pending game syncs queue in `localStorage` and flush on reconnect. |
| P2P connection fails | PeerJS `error` event or no data-channel open within ~10s | Offer a bot fallback at the matched rating so the user still gets a game. |
| Stockfish fails to load | Engine `onError`, or `readyPromise` rejects | Disable bot play and post-game analysis. Human games remain fully playable. The board and rules do not depend on the engine. |
| Opponent disconnects mid-game | Data channel `close` or inactivity timeout | Game is scored as abandoned; the disconnecting player forfeits on time, the remaining player may submit the result. |
| Tab inactive | `visibilitychange` → `hidden` | Clock pauses. Resumes on focus. This prevents background-tab throttling from silently burning a player's clock. |
| Worker 30s wall limit | Long-poll approaching 25s mark | Client re-issues the poll; the DO state is preserved between polls. |

## Performance considerations

- **D1 reads.** The free tier allows 5M reads/day. Leaderboard is the hottest endpoint and would otherwise hammer the `users` table, so it is cached at the edge for 60 seconds via the Workers Cache API. A typical ranked game makes roughly 10 Worker calls (auth refresh, queue, a few polls, submit); at that rate a user would need ~500k games/day to hit the limit.
- **Worker wall-clock.** Workers have a 30-second wall-clock limit. Long-polls are issued with a 25-second client-side timeout so the request returns cleanly before the Worker is killed, then the client re-polls. The DO keeps queue state across polls.
- **Stockfish WASM size.** The engine binary is roughly 1MB. It is served from the same Pages origin as the rest of the static assets, so it benefits from the same aggressive cache headers and CDN. After first load it is served from disk cache on subsequent visits.
- **Board rendering.** Pieces use CSS transforms (`translate3d`) for movement, which the browser composites on the GPU. No layout work happens during drag or animation, so 60fps holds even on mid-range mobile.
- **Durable Object cost.** DOs bill per request and per gigasecond of duration on the free tier's 100k requests/day. The queue DO is hot only during active matchmaking, so it has negligible wall duration.

## Security model

ChessRight is honest about its threat model: it is a hobby chess site, not a tournament platform. The security model is calibrated accordingly.

- **Anonymous auth, no passwords.** Identity is a randomly generated user ID signed with an HMAC secret known only to the Worker (`AUTH_SECRET`). Tokens are returned to the client and sent back in the `Authorization` header. There is no PII and no password to leak; the worst case of a stolen token is that someone else can play rated games under your handle.
- **Server-authoritative ratings.** The client cannot claim a win. Rating updates are computed inside the Worker (`elo.js`) from a submitted game record. A client that tampers with the payload can at best pollute its own game history; it cannot inflate its rating without submitting games that pass server-side validation.
- **Result cross-checking.** Both clients must POST the same terminal hash (a digest over the move sequence and final position). If the hashes disagree, the Worker rejects the submission. This catches accidental divergence and casual cheating; it does not catch two colluding clients, which is fundamentally unsolvable without server-side move verification.
- **Anti-cheat is minimal, by design.** We do not run engine-detection on submitted games. Anyone determined to cheat can play engine moves over the board on another site. This is the same gap every chess platform has short of full server-side move analysis. We document it here rather than pretend otherwise.

For deeper treatment of how ratings are computed and why, see [ACCURACY.md](ACCURACY.md).
