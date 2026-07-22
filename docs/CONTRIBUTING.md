# Contributing

ChessRight is a small project and contributions are welcome. The codebase is intentionally plain — vanilla JS, no build step on the frontend, no framework — specifically so it stays hackable.

## Local dev

Follow the [quick start in the README](../README.md#quick-start-local-dev):

```bash
# Terminal 1 — frontend
cd web && python -m http.server 8785

# Terminal 2 — backend
cd worker && npm install && npx wrangler d1 execute chessright --file=./schema.sql --local
npx wrangler dev
```

Open `http://localhost:8785` and you should be playing bot games against local Stockfish inside a minute.

## Code style

- **ES modules** everywhere (`import` / `export`). No CommonJS, no bundler.
- **No comments in shipped code.** Explain yourself through names and structure. Comments rot faster than code; if a function needs a comment to be understandable, refactor it. (Architecture context belongs in this `docs/` folder, not in the source.)
- **No `console.log` in shipped code.** They are fine while debugging; remove before commit.
- **Formatting:** 2-space indent, single quotes, trailing commas in multi-line collections. Roughly Prettier defaults; if you want to enforce it locally, `npx prettier --write` against the repo's config will not be far off.
- **Files are small and single-purpose.** A module that needs a table of contents in a header comment should be two modules.

## Testing

There is no test runner wired up as a CI gate (yet); we keep the barrier low instead:

- Every module must pass a syntax check: `node --check path/to/file.js`. Run this before opening a PR.
- Pure modules (notably `web/scripts/play/accuracy.js` and `worker/src/elo.js`) carry co-located `*.test.js` files. Run them with `node --test path/to/file.test.js`. If you change the math, update or add tests.
- Integration is validated by hand in the browser: start a bot game, finish a ranked game against a second session, check the post-game report and the profile page.

If your PR touches the rating or accuracy math, please include the numbers you tested against and where they came from (e.g. a known Lichess analysis). See [ACCURACY.md](ACCURACY.md) for the formulas these tests should reflect.

## Pull requests

- Small and focused. A PR that does one thing well is reviewed and merged; a PR that does four things is stalled for two weeks.
- Write a clear description: what changed, why, how you tested it, anything the reviewer should look at closely.
- Open a draft PR early if you want feedback before the work is finished.

## Areas that need help

These are real gaps; if any of them appeal to you, open an issue first so we can scope it together:

- **TURN server setup.** WebRTC P2P fails for some network topologies (symmetric NATs in particular) without a TURN relay. We have no TURN server today; that means some players cannot establish a connection. A documented coturn deployment, or integration with a free TURN provider, would unblock those users.
- **Mobile UX testing.** The board is sized for desktop. Touch dragging, viewport sizing, and the post-game report layout all need a proper pass on real phones and tablets.
- **Accessibility audit.** The board uses custom pointer interactions that are not keyboard-navigable. The landing page mostly works with a screen reader but has never been formally audited. We want WCAG-AA on the core play loop.
- **Opening explorer.** Showing book moves and win-rate-by-reply in the post-game report, and eventually a free-standing explorer, is a natural next feature that requires a book dataset (e.g. a curated Lichess export) and a small viewer.

If you have a different idea, open an issue and we will talk about it.
