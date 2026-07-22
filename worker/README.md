# ChessRight API (Cloudflare Worker)

Server backend for ChessRight: anonymous-token auth, game persistence (D1), leaderboard, matchmaking (Durable Object), and invite codes.

## Stack

- Hono router (`^4.6.0`) on Cloudflare Workers
- D1 (SQLite at the edge) for `users`, `games`, `invites`
- Durable Object `MatchQueue` for in-memory matchmaking coordination
- Web Crypto (`crypto.subtle`) HMAC-SHA256 tokens, no external deps

## Layout

```
worker/
  schema.sql        D1 schema
  wrangler.toml     bindings (DB, MATCH_QUEUE), CORS_ORIGIN var
  package.json      hono + wrangler
  test.sh           lists files and runs `node --check src/*.js`
  src/
    index.js        Hono router, CORS, route wiring, exports MatchQueue DO
    auth.js         anonymous tokens, authMiddleware, /api/auth/*
    elo.js          Glicko-1 (mirrors web/scripts/play/store.js)
    games.js        /api/games (POST/GET list/:id/stats)
    leaderboard.js  /api/leaderboard (60s Workers Cache)
    queue.js        MatchQueue Durable Object
    invite.js       /api/match/invite (create, peek, claim)
```

## API

All under `/api`. Protected routes require `Authorization: Bearer tok_<userId>.<hmac>`.

```
POST /auth/anonymous                       { userId, handle, token, rating }
GET  /auth/me            (auth)            { id, handle, rating, rating_rd, gamesPlayed, wins, losses, draws }

POST /games              (auth)            body { pgn, moves, opponent, result, color, ... } -> { id, game }
GET  /games              (auth)            ?limit&offset -> { games, limit, offset }
GET  /games/:id          (auth)            -> Game
GET  /games/stats        (auth)            -> { gamesPlayed, wins, losses, draws, avgAccuracy, ... }

GET  /leaderboard                          ?limit=100 (60s cached)

POST /match/queue        (auth)            { rating?, peerId, timeControl? } -> { ticketId, status }
GET  /match/poll/:ticketId                 -> { status: 'waiting'|'matched'|'expired', game? }
DELETE /match/queue/:ticketId (auth)       -> { status: 'removed'|'not_in_queue' }
GET  /match/stats                          -> { waiting, matches }

POST /match/invite       (auth)            { peerId, timeControl? } -> { code, expiresAt }
GET  /match/invite/:code                   -> { status: 'available'|'taken', creatorPeerId, creatorRating, ... }
POST /match/invite/:code/claim             -> atomically marks taken, returns creator info (409 if already taken)
```

Errors are always JSON: `{ error: 'message', code: 'CODE' }`. Status codes: 401 unauth, 403 forbidden, 404 not found, 409 conflict, 422 invalid body.

## Deploy

```bash
npm install
npx wrangler login

npx wrangler d1 create chessright
# paste the printed database_id into wrangler.toml

npx wrangler d1 execute chessright --file=./schema.sql
npx wrangler d1 execute chessright --local --file=./schema.sql   # for `wrangler dev`

# strong random secret, e.g. `openssl rand -hex 32`
npx wrangler secret put AUTH_SECRET

# production CORS: set to your Pages domain
npx wrangler deploy
```

Set `CORS_ORIGIN` in `wrangler.toml` `[vars]` to the production Pages origin (e.g. `https://chessright.pages.dev`). Defaults to `http://localhost:8785` for local dev.

## Local dev

```bash
npm run dev     # wrangler dev, default http://localhost:8787
npm run db:migrate -- --local
```

Point the Vite dev proxy at `http://localhost:8785` (or whatever `wrangler dev` reports) so `/api/*` requests hit the Worker.

## Decisions

- **Tokens**: `tok_<userId>.<base64url HMAC-SHA256(userId, AUTH_SECRET)>`. Stateless validation (recompute + verify); user existence is checked against D1 on each authed request.
- **Elo**: Glicko-1 with `q = ln(10)/400`, opponent RD fixed at 50, RD decays toward 350 over time, constants identical to the client (`DAY_MS`, `C_DECAY=63.2`, `RD_MIN=30`, `RD_MAX=350`). For bot games only the human's row updates; bot rating stays fixed.
- **MatchQueue DO**: single global instance named `global` (single-threaded in-memory coordinator). Active queue lives in a `Map`; finalized matches persist to DO storage so polls survive eviction. Long-poll cap is 25s (under Workers' 30s ceiling); window is `50 + elapsed*8`, capped at 300. The `userId` is used as a re-queue guard so re-POSTing queue doesn't spawn duplicate tickets for one user.
- **Leaderboard**: `RANK() OVER (ORDER BY rating DESC)` filtered to `games_played >= 5`, cached in Workers Cache API for 60s.
- **Invite codes**: 6 chars, alphabet excludes `O/0/I/1`. GET is idempotent; claiming happens via `POST .../claim` which uses a conditional `UPDATE ... WHERE taken_at IS NULL` so the first claim wins (others get 409). Codes are TTL-purged on read (1 hour).
- **Game dedup**: SHA-256 over `{userId, moves, pgn, opponentKind, opponentName, color}`; `(user_id, hash)` has a unique index, retries return the existing row.
