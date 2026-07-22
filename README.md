# ChessRight — Play chess. Find brilliancies.

ChessRight is a free, open-source chess platform that runs entirely on Cloudflare's edge. Play the engine in your browser, find ranked opponents over WebRTC, track a Glicko-rated profile, and get a post-game move-quality breakdown that surfaces the moves you missed and the ones you played better than the engine expected.

No account is required to start playing. There are no passwords — identity is an HMAC-signed anonymous token stored locally, optionally promoted to a cross-device profile once you register.

## Features

- **Play the engine.** Stockfish 16 compiled to WebAssembly, running in a Web Worker. Skill maps to a 1320–3190 ELO range across 20 levels.
- **Play humans, peer-to-peer.** Ranked matches are introduced through a server-side matchmaking queue, then carried entirely over a WebRTC data channel. Live move traffic never touches Cloudflare.
- **Ranked matchmaking.** Glicko-1 ratings with a queue coordinator implemented as a Durable Object.
- **Accuracy-based strength estimate.** After each game, win-probability loss per move is rolled up into a per-move accuracy and a per-game estimated ELO. Independent of result, so you can lose and still see that you played well.
- **Game history.** Every rated game is persisted server-side (D1 / SQLite) with PGN, move list, accuracy buckets, and result — viewable from your account page across devices.
- **Leaderboard.** Top-100 by rating, cached at the edge for 60 seconds.

## Architecture

A static frontend (Cloudflare Pages) talks to a Hono-backed Cloudflare Worker over REST for queue, auth, persistence, and leaderboard calls. Once two players are matched, move traffic moves off the Worker entirely and runs over a peer-to-peer WebRTC data channel. Stockfish runs in the browser as a WASM Web Worker — no engine compute happens on the server.

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

For component responsibilities, data flow, failure modes, and the security model see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start (local dev)

You need two terminals: one for the static frontend and one for the Worker.

```bash
# Terminal 1 — Frontend (any static server; python is a convenient zero-config option)
cd web
python -m http.server 8785
# Frontend now serves at http://localhost:8785

# Terminal 2 — Worker
cd worker
npm install
npx wrangler dev
# API now serves at http://localhost:8787 (or whatever wrangler prints)
```

The frontend's default API base points at `http://localhost:8787` for local development. Override `API_BASE` in `web/scripts/play/net.js` if your Worker runs on a different port.

For first-time Worker setup you also need the D1 schema applied locally:

```bash
cd worker
npx wrangler d1 execute chessright --file=./schema.sql --local
```

Open `http://localhost:8785`, click **Play**, and start a bot game to confirm the engine loaded. Live match play requires a second browser session (or a friend) to pair against.

## Tech stack

- **Frontend:** vanilla ES modules + HTML + CSS, no bundler. chess.js for rules, PeerJS for WebRTC signaling, vendored Stockfish 16 WASM.
- **Backend:** Cloudflare Worker with the [Hono](https://hono.dev/) router. Anonymous HMAC token auth.
- **Data:** Cloudflare D1 (SQLite) for users, games, invites. A `MatchQueue` Durable Object coordinates matchmaking. Client-side `localStorage` for offline-first ratings and pending syncs.
- **Networking:** REST for queue/auth/leaderboard; WebRTC data channels (via PeerJS) for live gameplay.

## Project structure

```
ChessRight/
├── web/                    # Cloudflare Pages static frontend
│   ├── index.html          # landing page (with the brilliancy animation)
│   ├── play.html           # game client (lobby + board + post-game)
│   ├── account.html        # profile, history, leaderboard
│   ├── assets/styles/      # base.css, landing.css, play.css, account.css
│   ├── assets/stockfish/   # vendored stockfish.js + .wasm
│   └── scripts/
│       ├── landing.js      # the brilliancy animation
│       ├── ui.js           # shared toasts/modals/format helpers
│       ├── account.js
│       └── play/
│           ├── main.js     # game controller
│           ├── board.js    # custom board renderer + interaction
│           ├── engine.js   # Stockfish WASM worker wrapper
│           ├── accuracy.js # win-probability accuracy + ELO estimation
│           ├── store.js    # localStorage persistence (Glicko-1 ratings)
│           ├── net.js      # PeerJS + matchmaking API client
│           └── clock.js    # increment chess clocks
├── worker/                 # Cloudflare Worker backend
│   ├── src/
│   │   ├── index.js        # Hono router
│   │   ├── auth.js         # anonymous HMAC token auth
│   │   ├── elo.js          # server-side Glicko-1
│   │   ├── games.js        # game persistence (D1)
│   │   ├── leaderboard.js  # top-100 query + cache
│   │   ├── queue.js        # MatchQueue Durable Object
│   │   └── invite.js       # 6-char invite codes
│   ├── schema.sql
│   ├── wrangler.toml
│   └── package.json
├── shared/                 # constants shared across client/server
└── docs/                   # this documentation
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, failure modes, security model.
- [Deploy](docs/DEPLOY.md) — step-by-step to your own Cloudflare account.
- [Accuracy math](docs/ACCURACY.md) — win-probability model, per-move accuracy, ELO estimation, Glicko-1.
- [Contributing](docs/CONTRIBUTING.md) — local dev, code style, areas that need help.

## License

MIT. See `LICENSE`.

## Acknowledgments

- [Stockfish](https://stockfishchess.org/) — the engine, here compiled to WASM.
- [chess.js](https://github.com/jhlywa/chess.js) — move generation, legality, checkmate detection.
- [PeerJS](https://peerjs.com/) — WebRTC abstraction for the data channel.
- [Lichess](https://lichess.org/) — the win-probability and accuracy models are derived from their published work; see [docs/ACCURACY.md](docs/ACCURACY.md) for the source and our adaptations.
- [Cloudflare](https://www.cloudflare.com/) — Workers, D1, Durable Objects, and Pages, all on the free tier.
