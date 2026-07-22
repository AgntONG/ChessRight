# ChessRight — Free Chess, Free Training

Play chess against Stockfish, challenge a friend with a link, and get instant post-game analysis. No account, no ads, no paywall. Forever free.

**Live:** https://agntong.github.io/ChessRight/

## What you can do

- **Play the Engine** — Stockfish in your browser, 20 skill levels from beginner to grandmaster.
- **Play a Friend** — Share a link, they click, you're playing. Peer-to-peer over WebRTC, no server in the live path.
- **Game Analysis** — Every game analyzed: accuracy %, blunders, brilliancies, an estimated-strength number per game.
- **Track Progress** — Glicko-1 rating, game history, and stats, all stored locally in your browser.
- **ELO Estimation** — A move-quality-based strength estimate shown alongside your results rating. The two answer different questions — see [docs/ACCURACY.md](docs/ACCURACY.md).

## Quick start (local dev)

```bash
cd web
python -m http.server 8765
# open http://localhost:8765
```

No build step. No `npm install` needed for the frontend. If you need the npm helper scripts (syntax check, etc.), run `npm install` at the repo root.

## Tech stack

- **Frontend:** vanilla ES modules + HTML + CSS. No React, no Vue, no bundler.
- **Engine:** Stockfish 16 WASM, vendored in `web/assets/stockfish/`.
- **Rules:** [chess.js](https://github.com/jhlywa/chess.js) for move validation.
- **Multiplayer:** [PeerJS](https://peerjs.com/) over WebRTC (P2P, no server needed in the live path).
- **Persistence:** `localStorage` (offline-first).
- **Ratings:** Glicko-1, with Lichess-style win-probability for accuracy.

## Project structure

```
ChessRight/
├── web/                        # GitHub Pages static site
│   ├── index.html              # Landing page (with the brilliancy animation)
│   ├── play.html               # Game client
│   ├── account.html            # Profile, history, stats
│   ├── assets/
│   │   ├── styles/             # base, landing, play, account CSS
│   │   └── stockfish/          # Vendored Stockfish WASM
│   └── scripts/
│       ├── landing.js          # Marshall vs Levitsky brilliancy animation
│       ├── ui.js               # Shared toasts/modals/format helpers
│       ├── account.js          # Profile page controller
│       └── play/
│           ├── main.js         # Game controller
│           ├── board.js        # Custom board renderer
│           ├── engine.js       # Stockfish WASM wrapper
│           ├── accuracy.js     # Win-probability accuracy + ELO estimation
│           ├── store.js        # localStorage persistence (Glicko-1)
│           ├── net.js          # PeerJS invite/host/guest P2P
│           └── clock.js        # Increment chess clocks
├── docs/                       # Documentation
│   ├── ARCHITECTURE.md
│   ├── ACCURACY.md             # The math behind accuracy + ELO
│   └── CONTRIBUTING.md
├── .github/workflows/deploy.yml
└── README.md
```

## Deploy

Push to `main`. The [GitHub Actions workflow](.github/workflows/deploy.yml) stages `web/` and publishes to GitHub Pages. There is nothing else to deploy — no backend, no API, no database.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data flow, failure modes.
- [Accuracy math](docs/ACCURACY.md) — win-probability model, per-move accuracy, ELO estimation, Glicko-1.
- [Contributing](docs/CONTRIBUTING.md) — local dev, code style, areas that need help.

## License

MIT. Stockfish is GPLv3 (vendored binary). chess.js and PeerJS are MIT.

## Acknowledgments

- [Stockfish](https://stockfishchess.org/) — the engine.
- [chess.js](https://github.com/jhlywa/chess.js) — move validation.
- [PeerJS](https://peerjs.com/) — WebRTC made simple.
- [Lichess](https://lichess.org) — inspiration for the accuracy model and skill-level mapping.
- The game of Levitsky vs Marshall, Breslau 1912 — the brilliancy on our landing page.
