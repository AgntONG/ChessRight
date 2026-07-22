# Architecture

ChessRight is a frontend-only chess platform. Everything runs in the browser — no server, no database, no API. The only network dependency is the PeerJS broker (used to establish P2P connections) and the free STUN servers used during WebRTC negotiation.

## Overview

```
Browser
┌──────────────────────────────────────────────────┐
│  Pages: index.html · play.html · account.html    │
│                                                  │
│  Stockfish WASM (Web Worker)                     │
│    ↳ bot opponent · post-game analysis           │
│                                                  │
│  PeerJS (WebRTC P2P)                             │
│    ↳ invite links · real-time moves              │
│                                                  │
│  localStorage                                    │
│    ↳ user profile · game history · ratings       │
└──────────────────────────────────────────────────┘
```

No part of a game — moves, clocks, results, ratings — touches a server we operate. The trade-offs of that shape most of this document.

## Component responsibilities

### Pages

- **`index.html`** — Landing page. The signature element is the Marshall brilliancy animation in `landing.js` (Levitsky vs Marshall, Breslau 1912): a single tactical sequence rendered on a custom board. Its only role is to make visitors click Play.
- **`play.html`** — Game client: lobby (bot or friend), board, eval bar, clocks, post-game analysis. The `scripts/play/` modules below collaborate to drive this page.
- **`account.html`** — Profile, game history with replay, and stats. Reads entirely from `localStorage` via `store.js`.

### Modules (`web/scripts/play/`)

- **`main.js`** — `GameController`: orchestrates board, engine, clock, P2P, and store into a state machine (`lobby → in-game → ended`). Owns the canonical move list during play.
- **`board.js`** — Custom board renderer (CSS grid + absolutely-positioned pieces, GPU-composited transforms for movement). Purely presentational; move legality lives in `chess.js`.
- **`engine.js`** — Stockfish WASM wrapper. Owns the Web Worker lifecycle, UCI protocol (`position`, `go`, `setoption`), and Lichess-style skill scaling across 20 levels mapped to a 1320–3190 ELO range.
- **`accuracy.js`** — Pure, stateless functions turning `(eval-before, eval-after)` pairs into per-move accuracies, a game-average accuracy, and an estimated ELO. Fully specified in [ACCURACY.md](ACCURACY.md).
- **`store.js`** — `localStorage` persistence. Owns the user profile, game history, and Glicko-1 rating math (the same formulas ACCURACY.md describes).
- **`net.js`** — PeerJS invite host/guest for P2P multiplayer. Handles the `CR-XXXXXX` invite-code flow and the WebRTC data channel used for moves.
- **`clock.js`** — Increment chess clocks with drift correction. Pauses on `visibilitychange` to prevent background-tab throttling from stealing a player's time.

### Key design decisions

- **No build step.** Vanilla ES modules with relative imports. The browser handles everything. The cost is giving up bundler niceties (tree-shaking, minification, HMR); the benefit is that the repo runs with `python -m http.server` and stays readable end-to-end.
- **No framework.** Keeps the bundle small and the code accessible to contributors who don't know your specific framework. The DOM is small enough that a framework would not pay for itself.
- **Offline-first.** All game data — profile, ratings, history — lives in `localStorage`. Bot games work fully offline. P2P games need the network only for the live connection itself.
- **Custom board.** Built from scratch rather than using `cm-chessboard` or `chessground`. The interaction primitives (click-to-select, drag-to-move, drop-highlighting) are shared with the landing-page brilliancy animation, so the two render identically.
- **No trusted authority.** Without a server there is no server-authoritative rating and no anti-cheat. Ratings reflect what the local client computed and stored. This is calibrated to the project's goals (a free, friendly place to play), not to tournament integrity. See [Limitations](#limitations).

## Data flow

### Bot game

1. User picks a skill level → `engine.js` configures Stockfish via UCI `setoption` (depth limit, skill level, and the random-move subroutines that emulate lower ELOs).
2. User moves → `chess.js` validates → `board.js` animates → engine evaluates the resulting position.
3. Bot's turn → `engine.bestMove({ fen })` → controller applies the move → eval bar updates.
4. Game ends (mate, stalemate, resignation, timeout, draw) → `analyzeGame(moveHistory)` runs each position through Stockfish → per-move accuracy + estimated ELO → `store.saveGame()`.

### P2P game (invite link)

1. Host clicks "Create game" → `net.js` mints a `CR-XXXXXX` code, registers a PeerJS peer with that ID on the public broker, and shows a shareable link `play.html?join=CR-XXXXXX`.
2. Guest opens the link → `net.js` reads the code from the query string and opens a WebRTC connection to the host's peer ID.
3. The WebRTC data channel carries moves: `{ t: 'move', from, to, promotion, clockAfter }`. Each side runs the move through `chess.js` locally and redraws.
4. Game ends → both sides compute accuracy independently and call `store.saveGame()` locally.

This is honor-system P2P. There is no arbiter: each client trusts the other's move legality (validated locally by `chess.js` against the position, which catches accidental illegal moves) and trusts the other not to be running an engine. That is fine for friendly games; it is the fundamental ceiling of a design with no server in the live path.

## Failure modes

| Failure | Detection | Fallback |
|---|---|---|
| Stockfish fails to load | `engine.js` `onError`, or `readyPromise` rejects | Bot play and post-game analysis are disabled. Human games are unaffected — the board and rules do not depend on the engine. |
| P2P connection fails | PeerJS `error` event, or no data-channel open within ~10s | Surface a clear error and offer a bot game at the chosen skill level so the user still gets to play. Symmetric NAT and the absence of a TURN relay are the most common causes. |
| `localStorage` full | `setItem` throws `QuotaExceededError` | Games are capped at 500 (oldest dropped on insert). Profile and most-recent games are kept; older history is sacrificed first. |
| Opponent disconnects mid-game | Data channel `close` or inactivity timeout | Game is scored as abandoned; the local side may save the result. |
| Tab backgrounded | `visibilitychange → hidden` | Clock pauses. Resumes on focus. Prevents browser background-tab throttling from silently burning a player's clock. |

## Performance

- **Stockfish WASM** is roughly 575 KB on the wire. It is served from the same origin as the rest of the static assets on GitHub Pages, so it inherits the browser's HTTP cache and is served from disk on subsequent visits.
- **Board rendering** uses CSS `translate3d` transforms for piece movement, which the browser composites on the GPU. No layout work happens during drag or animation, so 60fps holds on mid-range mobile.
- **PeerJS** uses the free public broker (`0.peerjs.com`) for signaling and Google's public STUN servers for ICE. Both are free, rate-limited, and fine for hobby-scale traffic. A self-hosted broker or TURN relay would be needed for higher reliability — see [Contributing](CONTRIBUTING.md).

## Limitations

A frontend-only design has a hard ceiling. The things it cannot do are not bugs to fix inside the current architecture; they are the cost of the design.

- **No cross-device profile.** Your rating, history, and handle live in the browser you played in. Clearing storage, switching devices, or using private mode starts you over. The `store.exportData()` JSON is the manual escape hatch.
- **No authoritative rating.** A rating computed and stored on the client can be edited by the client. The number on the profile page is informational, not a credential.
- **No anti-cheat in P2P games.** An opponent running Stockfish in another tab is undetectable from within the browser. There is no move-verification server to catch this.
- **No global leaderboard.** Without a shared server, there is no place to aggregate ratings across players. The "leaderboard" is your own history.
- **P2P reliability depends on network topology.** Two players behind symmetric NATs cannot connect without a TURN relay. We don't operate one.
