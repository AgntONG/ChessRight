# ChessRight API Specification

Formal contract for the ChessRight multiplayer backend (Cloudflare Workers + Durable Objects). This document is the source of truth for both frontend and backend implementations. Where prose and code disagree, the contract below wins; the implementation must be brought into line.

- **Spec version:** 1.0
- **Last updated:** 2026-07-22
- **Base URL (prod):** `https://chessright-api.workers.dev` (replace with the deployed Worker route)
- **Base URL (local):** `http://localhost:8787`
- **All paths below are relative to the base URL.** Every REST path begins with `/api`.

---

## 1. Consumer model

| Consumer | Where it runs | What it needs |
|---|---|---|
| **Browser client** (`web/`, GitHub Pages) | End-user browser | Anonymous auth, game save/restore, stats, leaderboard, matchmaking, invite codes, learning reviews, real-time game WS. |
| **GameRoom WebSocket** | Same browser tab during a live game | Authoritative move validation, clock, draw/resign/chat, opponent connectivity, prank injection. |
| **Admin tooling** | Operator dashboard / scripts | Active-game inspection, user search/ban, prank injection, platform stats. Gated by `X-Admin-Token`. |

## 2. Paradigm choice

- **REST** for stateless resources (auth, games, leaderboard, invites, learning, admin, matchmaking tickets). Resources are nouns; methods convey the verb; pagination via query params; uniform error envelope.
- **WebSocket** for the one place that is fundamentally a stream — a live game. Moves, clock ticks, draws, chat, and connectivity events are bidirectional, low-latency, and stateful, which REST cannot model well.
- **Long-poll** (`GET /match/poll/:ticketId`) for matchmaking. It is a short-lived wait for a single state transition, kept inside the Workers 30s subrequest ceiling (25s server cap). Not WS because the consumer has no socket yet and only needs one event.

## 3. Cross-cutting design

### 3.1 Versioning

- URL prefix: **`/api/`** with no version token in v1. The `/api` prefix *is* the version namespace.
- Additive changes (new fields, new endpoints, new optional params, new error codes) are non-breaking and ship under `/api` without ceremony.
- The first breaking change (renamed/removed field, changed semantics, removed endpoint) introduces `/api/v2/...` and freezes `/api/` for a documented deprecation window. There is no header-based versioning.
- Every response carries `X-API-Version: 1`.

### 3.2 Authentication

| Mechanism | Where |
|---|---|
| **Bearer token** (`Authorization: Bearer <token>`) | All authed REST routes. |
| **Query token** (`?token=<token>`) | WebSocket upgrade only (browsers cannot set headers on WS). |
| **`X-Admin-Token`** | All `/api/admin/*` routes, in addition to (not instead of) Bearer where the admin action is user-scoped. |

- Tokens are issued by `POST /api/auth/anonymous` and refreshed by `POST /api/auth/refresh`.
- Token format: `tok_<userId>.<issuedAtMs>.<nonce>.<base64url hmac>`, HMAC-SHA256 over `tok|<userId>|<issuedAtMs>|<nonce>` with the server's `AUTH_SECRET`. TTL 24h. Nonces are single-use (consumed from `seen_nonces` on validation), which means **a token may be used exactly once per REST call and exactly once to open a WS** — clients must call `/auth/refresh` (or re-issue) before each long-lived use. See §6.2 for the implication on WS reconnect.
- Every authed request additionally confirms the user row exists and `is_banned = 0`. Banned users get `403 BANNED`.

### 3.3 CORS

All responses include:

```
Access-Control-Allow-Origin: <CORS_ORIGIN or echo of allowed Origin>
Vary: Origin
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type, X-Admin-Token
Access-Control-Max-Age: 86400
```

- `OPTIONS` preflight returns `204 No Content` with the headers above.
- Production `CORS_ORIGIN` is the GitHub Pages origin (set via wrangler `[vars]`); `*` is permitted for local dev only.
- WebSocket origin allow-list is `ALLOWED_WS_ORIGINS` (comma-separated). Upgrade is rejected with `403` if the `Origin` header is not on the list.

### 3.4 Rate limiting

- Every mutating endpoint (`POST`, `DELETE`) and the long-poll participate in a per-IP, per-route token bucket.
- Rate-limited responses return `429` with `Retry-After` (seconds) and:

```
X-RateLimit-Limit:     <bucket size>
X-RateLimit-Remaining: <tokens left>
X-RateLimit-Reset:     <epoch seconds when bucket refills>
```

- Default budgets (tunable, not contractually fixed): auth `30/min`, matchmaking `60/min`, game-save `60/min`, learning review `200/min`, admin `300/min`. `GET` read paths are effectively unmetered but may be cached.

### 3.5 Error envelope

Every error response uses **exactly one shape**, with HTTP status carrying the class:

```json
{ "error": "human-readable summary", "code": "MACHINE_CODE" }
```

Optional third key `details` (object or array) MAY appear for validation errors, e.g. `details: { "field": "color", "issue": "must be 'w' or 'b'" }`. Clients must ignore keys they do not understand.

**Status vocabulary used:**

| Code | Meaning | Example code |
|---|---|---|
| `400` | Malformed request (bad JSON, missing path param shape) | `INVALID_BODY` |
| `401` | Missing/invalid/expired token | `UNAUTHORIZED` |
| `403` | Authenticated but not allowed (banned, not your resource, bad admin token, bad WS origin) | `FORBIDDEN`, `BANNED` |
| `404` | Resource does not exist | `NOT_FOUND` |
| `409` | State conflict (invite already claimed) | `ALREADY_TAKEN` |
| `422` | Well-formed JSON that fails semantic validation | `INVALID_BODY`, `INVALID_CODE` |
| `429` | Rate limited | `RATE_LIMITED` |
| `500` | Server error | `INTERNAL`, `MISCONFIGURED` |
| `503` | Required backend not configured (e.g. admin secret unset) | `ADMIN_UNCONFIGURED` |

`200` is never used to carry an error in the body. Health checks (`GET /api/health`) return `200 { ok: true, ... }`.

### 3.6 Pagination, filtering, sorting

- **Offset pagination** is used everywhere a collection is returned. Uniform query params:
  - `limit` — integer, `1..100` for games, `1..500` for leaderboard. Default per endpoint.
  - `offset` — integer, `>= 0`. Default `0`.
- The envelope for a paginated collection is uniform:

```json
{ "games": [ ... ], "limit": 20, "offset": 0 }
```

- The collection key (`games`, `entries`, `items`) is named after the resource; `limit`/`offset` are always echoes of what was applied (clamped).
- Default sort is documented per endpoint (games: `created_at DESC`; leaderboard: `rating DESC`).
- No cursor pagination in v1 — collections are bounded and user-scoped. A v2 migration to cursor pagination would be additive (new `cursor` param + `nextCursor` field) and non-breaking.

### 3.7 Time format

- All timestamps are **integer epoch milliseconds** (`Date.now()` semantics), named with an `At`/`Ms` suffix (`createdAt`, `endedAt`, `durationMs`).
- Clocks in WS messages are integer milliseconds remaining (`clock.w`, `clock.b`).

### 3.8 Naming and casing

- **URLs:** lowercase, kebab-case, plural-noun collections (`/api/games`, `/api/leaderboard`). Path params are camelCase (`:ticketId`, `:gameId`).
- **JSON keys:** camelCase (`gamesPlayed`, `createdAt`, `ratingRd` on the wire). Where the DB stores snake_case (`rating_rd`, `games_played`), the API maps on the boundary and never leaks the snake_case form.
- **IDs:** prefixed opaque strings. `usr_<16>`, `gme_<12>`, `gm_<9>` (live game), `tkt_<9>` (match ticket), `tok_<...>` (token). Clients must treat them as opaque; do not parse the prefix.

### 3.9 Idempotency

- `POST /api/games` is **naturally idempotent** via content hash (SHA-256 over `{userId, moves, pgn, opponentKind, opponentName, color}`). Retries with the same payload return the existing row with `duplicate: true` and status `200` (not `201`). No client-supplied idempotency key is required in v1.
- `POST /api/match/queue` is **idempotent per user**: re-queueing while already in the queue returns the existing `ticketId` with `status: "waiting"`.
- `POST /api/match/invite/:code/claim` is **atomic conditional** (`UPDATE ... WHERE taken_at IS NULL`); first claim wins, others get `409 ALREADY_TAKEN`.
- Other `POST`s (`/auth/anonymous`, `/auth/refresh`, `/learn/review`, admin mutations) are **not** idempotent and have no idempotency key in v1. If money or irreversible side effects are added later, an `Idempotency-Key` header becomes mandatory for those endpoints.

---

## 4. REST endpoints

Every endpoint below documents: method, path, auth, request body, response body, status codes, error codes.

### 4.1 Auth

#### POST /api/auth/anonymous
Issue a new anonymous identity and token. No auth required.

**Request body:** none (empty or `{}`).

**Response `200 OK`:**
```json
{
  "userId": "usr_q3rf7n0p2mwxb1ca",
  "handle": "SwiftKnight42",
  "token": "tok_usr_q3rf7n0p2mwxb1ca.1719000000000.a8b2c7d91e0f.6HpZ...",
  "rating": 1200
}
```
- `userId`: `usr_` + 16 base36 chars.
- `handle`: generated server-side from `<Adjective><Piece><nn>`; collisions fall back to `<handle><4 base36>`.
- `token`: 24h TTL; single-use nonce.
- `rating`: always `1200` for a fresh account (Glicko-1 start).

**Errors:** `500 MISCONFIGURED` if `AUTH_SECRET` is unset; `500 INTERNAL` otherwise.

---

#### POST /api/auth/refresh
Rotate the token (new nonce/TTL) for the authenticated user. Use before opening a WebSocket or when the previous nonce has been consumed.

**Auth:** Bearer.

**Request body:** none.

**Response `200 OK`:**
```json
{ "token": "tok_<userId>.<ts>.<nonce>.<mac>" }
```
**Errors:** `401 UNAUTHORIZED`.

---

#### GET /api/auth/me
Current user profile.

**Auth:** Bearer.

**Response `200 OK`:**
```json
{
  "id":            "usr_q3rf7n0p2mwxb1ca",
  "handle":        "SwiftKnight42",
  "rating":        1247,
  "ratingRd":      312,
  "gamesPlayed":   18,
  "wins":          10,
  "losses":        6,
  "draws":         2,
  "isAdmin":       false
}
```
- `ratingRd`: Glicko-1 rating deviation (decays toward 350 over time; floor 30).
- `isAdmin`: boolean — gates whether `/api/admin/*` will accept this user's actions when paired with the admin token.

**Errors:** `401 UNAUTHORIZED` (missing/invalid token or user row gone); `403 BANNED`.

---

### 4.2 Matchmaking

#### POST /api/match/queue
Enter the global matchmaking queue. Returns immediately; the client then long-polls `/match/poll/:ticketId`.

**Auth:** Bearer.

**Request body (all optional):**
```json
{
  "rating":     1247,
  "peerId":     "peer_abc123...",
  "timeControl": "10+5"
}
```
| Field | Type | Constraint | Default |
|---|---|---|---|
| `rating` | integer | `>= 100` | authenticated user's `rating` |
| `peerId` | string | opaque WebRTC peer id; nullable | `null` |
| `timeControl` | string | `<minutes>+<increment>` e.g. `"10+5"`, `"3+2"`, `"5+0"`; nullable | `null` |

**Response `200 OK`:**
```json
{ "ticketId": "tkt_a1b2c3d4e", "status": "waiting" }
```
- `status`: `"waiting"` (queued, no opponent yet) or `"matched"` (rare — matched synchronously on this call; treat same as a poll that returns `matched`).
- **Idempotency:** re-POSTing while the user is already queued returns the existing `ticketId` with `status: "waiting"` (does not spawn a second ticket).

**Errors:** `401 UNAUTHORIZED`; `400 INVALID_BODY`; `429 RATE_LIMITED`.

**Matching algorithm (informational, not contractual):** window = `50 + elapsed_seconds * 8`, capped at 300; two players match when `|ratingA - ratingB| <= window(A)` AND `<= window(B)` AND (both `timeControl` null OR equal). Tickets expire after 5 minutes.

---

#### GET /api/match/poll/:ticketId
Long-poll a matchmaking ticket. Blocks up to 25s server-side waiting for a match.

**Auth:** none (the `ticketId` is an unguessable capability). Use Bearer if you have it; not required.

**Path params:** `ticketId` (`tkt_...`).

**Response `200 OK`** — one of three states:
```json
// still waiting — client should poll again
{ "status": "waiting" }

// matched — open the WebSocket at /api/game/:gameId/ws
{
  "status": "matched",
  "game": {
    "gameId":    "gm_0a1b2c3d4",
    "createdAt": 1719000000000,
    "me":        { "userId": "usr_...", "handle": "...", "rating": 1247, "peerId": "peer_...", "color": "w" },
    "opponent":  { "userId": "usr_...", "handle": "...", "rating": 1230, "peerId": "peer_...", "color": "b" }
  }
}

// ticket unknown / left queue / > 5 min stale
{ "status": "expired" }
```
- `color`: `"w"` or `"b"` — the side the polling user plays.
- Long-poll cap is 25s (under Workers' 30s subrequest ceiling). The client MUST handle a `200 { "status": "waiting" }` return within ~25s and re-poll, with exponential backoff optional.

**Errors:** `429 RATE_LIMITED`. Unknown/expired tickets return `200` with `status: "expired"` (not `404`) — the resource existed transiently; this is the documented terminal state.

---

#### DELETE /api/match/queue/:ticketId
Leave the queue before being matched.

**Auth:** Bearer (the caller should be the ticket owner; the server does not currently cross-check, but clients must not rely on deleting other users' tickets).

**Response `200 OK`:**
```json
{ "status": "removed" }      // or
{ "status": "not_in_queue" } // already matched, expired, or never existed
```
**Errors:** `401 UNAUTHORIZED`; `429 RATE_LIMITED`.

---

#### POST /api/match/invite
Create a 6-character invite code. The creator then waits for a guest to claim it.

**Auth:** Bearer.

**Request body:**
```json
{ "peerId": "peer_abc123...", "timeControl": "10+5" }
```
| Field | Type | Constraint |
|---|---|---|
| `peerId` | string | required, opaque WebRTC peer id |
| `timeControl` | string | optional, `<m>+<i>` format |

**Response `200 OK`:**
```json
{ "code": "7KQ3HM", "createdAt": 1719000000000, "expiresAt": 1719003600000 }
```
- `code`: 6 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `O/0/I/1`). TTL 1 hour. Codes are TTL-purged lazily on read.

**Errors:** `401 UNAUTHORIZED`; `422 INVALID_BODY` (missing `peerId`); `500 CODE_COLLISION` (5-allocation-attempt failure); `429 RATE_LIMITED`.

---

#### GET /api/match/invite/:code
Peek an invite code without claiming it.

**Auth:** none.

**Path params:** `code` — 6 chars from the invite alphabet. Server uppercases. Rejects `^[2-9A-HJ-NP-Z]{6}$`.

**Response `200 OK`:**
```json
// available
{
  "status":         "available",
  "creatorPeerId":  "peer_abc123...",
  "creatorRating":  1247,
  "timeControl":    "10+5",
  "createdAt":      1719000000000,
  "expiresAt":      1719003600000
}

// already claimed
{
  "status":         "taken",
  "creatorPeerId":  "peer_abc123...",
  "creatorRating":  1247
}
```
**Errors:** `422 INVALID_CODE` (bad format); `404 NOT_FOUND`; `429 RATE_LIMITED`.

---

#### POST /api/match/invite/:code/claim
Atomically claim an invite code. First caller wins; the caller then connects WebRTC/WebSocket to `creatorPeerId`.

**Auth:** none in v1 (the code itself is the capability). A future revision may require Bearer to attribute the claim.

**Request body:** none.

**Response `200 OK`:**
```json
{
  "status":         "taken",
  "creatorPeerId":  "peer_abc123...",
  "creatorRating":  1247,
  "timeControl":    "10+5"
}
```
**Errors:** `422 INVALID_CODE`; `404 NOT_FOUND`; `409 ALREADY_TAKEN`; `429 RATE_LIMITED`.

---

#### GET /api/match/stats
Queue depth (observability; not authed).

**Response `200 OK`:**
```json
{ "waiting": 12, "matches": 3 }
```
- `waiting`: number of tickets currently in queue.
- `matches`: number of matches finalized and still tracked in the DO.

---

### 4.3 Game persistence

Bot games and completed games are persisted here. Live multiplayer games live in the GameRoom DO until they finish, at which point both players' clients POST the finished game.

#### POST /api/games
Save a completed game. Triggers a Glicko-1 rating update for the authenticated user when `opponent.kind === "bot"` (for bot games, only the human row updates; bot rating is fixed).

**Auth:** Bearer.

**Request body:**
```json
{
  "pgn":          "1. e4 e5 2. Nf3 ...",
  "moves":        [ { "from": "e2", "to": "e4", "san": "e4" } ],
  "opponent": {
    "kind":   "bot",
    "name":   "Stockfish Level 10",
    "rating": 1900
  },
  "color":         "w",
  "result":        "win",
  "ending":        "checkmate",
  "accuracy":      92.4,
  "estimatedElo":  1850,
  "buckets":       { "blunder": 1, "mistake": 2, "good": 18 },
  "durationMs":    612000,
  "startedAt":     1718999388000,
  "endedAt":       1719000000000
}
```
| Field | Type | Constraint |
|---|---|---|
| `pgn` | string | optional, default `""` |
| `moves` | array | **required** — move objects (shape is client-defined; server stores verbatim) |
| `opponent.kind` | enum | `"bot"` \| `"human"` — required |
| `opponent.name` | string | required, non-empty |
| `opponent.rating` | integer | optional, nullable |
| `color` | enum | `"w"` \| `"b"` — required |
| `result` | enum | `"win"` \| `"loss"` \| `"draw"` — required (from the authenticated user's perspective) |
| `ending` | string | optional, default `"normal"`. Free-form but conventional values: `"checkmate"`, `"stalemate"`, `"resignation"`, `"timeout"`, `"draw"`, `"abandoned"`, `"normal"` |
| `accuracy` | number | optional `0..100`, nullable |
| `estimatedElo` | integer | optional, nullable |
| `buckets` | object | optional; opaque `{ blunder, mistake, good, ... }` |
| `durationMs` | integer | optional, nullable; alias `duration_ms` accepted |
| `startedAt` | integer | optional, nullable; aliases `started_at` accepted; defaults to `endedAt` |
| `endedAt` | integer | optional, default `Date.now()`; alias `ended_at` accepted |

**Response `201 Created` (new game):**
```json
{
  "id": "gme_a1b2c3d4e5f6",
  "game": { /* full Game object, see GET /api/games/:id */ }
}
```
**Response `200 OK` (duplicate — same content hash already saved):**
```json
{ "id": "gme_a1b2c3d4e5f6", "duplicate": true, "game": { /* Game */ } }
```
**Errors:** `401 UNAUTHORIZED`; `422 INVALID_BODY` (missing/invalid `moves`, `opponent.kind`, `opponent.name`, `color`, `result`); `400 INVALID_BODY` (bad JSON); `429 RATE_LIMITED`.

---

#### GET /api/games
List the authenticated user's games, newest first.

**Auth:** Bearer.

**Query:** `limit` (`1..100`, default `20`), `offset` (`>=0`, default `0`).

**Response `200 OK`:**
```json
{
  "games": [ { /* Game */ }, ... ],
  "limit":  20,
  "offset": 0
}
```
**Errors:** `401 UNAUTHORIZED`.

---

#### GET /api/games/:id
Fetch one game. Only the owner may read it.

**Auth:** Bearer.

**Response `200 OK`** — the **Game** object (used by all game endpoints):
```json
{
  "id":            "gme_a1b2c3d4e5f6",
  "userId":        "usr_q3rf7n0p2mwxb1ca",
  "opponent":      { "kind": "bot", "name": "Stockfish Level 10", "rating": 1900 },
  "color":         "w",
  "result":        "win",
  "ending":        "checkmate",
  "pgn":           "1. e4 e5 ...",
  "moves":         [ { "from": "e2", "to": "e4", "san": "e4" } ],
  "accuracy":      92.4,
  "estimatedElo":  1850,
  "buckets":       { "blunder": 1, "mistake": 2, "good": 18 },
  "durationMs":    612000,
  "startedAt":     1718999388000,
  "endedAt":       1719000000000,
  "hash":          "9b1d...e3",
  "createdAt":     1719000001000
}
```
- `hash`: SHA-256 over `{userId, moves, pgn, opponentKind, opponentName, color}`. Used for dedup; clients should treat as opaque.
- Nullable fields: `accuracy`, `estimatedElo`, `buckets`, `durationMs`, `startedAt`, `opponent.rating`.

**Errors:** `401 UNAUTHORIZED`; `403 FORBIDDEN` (`user_id !== authenticated user`); `404 NOT_FOUND`.

---

#### GET /api/games/stats
Aggregate stats over the authenticated user's games.

**Auth:** Bearer.

**Response `200 OK`:**
```json
{
  "gamesPlayed":    18,
  "wins":           10,
  "losses":         6,
  "draws":          2,
  "avgAccuracy":    88.7,
  "avgEstimatedElo": 1620,
  "lastGameAt":     1719000000000
}
```
- `avgAccuracy` / `avgEstimatedElo`: `null` when no games with that field exist (not `0`).
- `lastGameAt`: `null` when the user has never played.

**Errors:** `401 UNAUTHORIZED`.

---

### 4.4 Leaderboard

#### GET /api/leaderboard
Top players by rating. Public, cached for 60s at the edge (response may include `cache-control: max-age=60`).

**Auth:** none.

**Query:** `limit` (`1..500`, default `100`).

**Response `200 OK`:**
```json
{
  "entries": [
    { "rank": 1, "handle": "CrimsonQueen99", "rating": 2487, "gamesPlayed": 312 },
    ...
  ],
  "cached": false
}
```
- Inclusion threshold: `games_played >= 5`.
- `rank`: dense rank via SQL `RANK() OVER (ORDER BY rating DESC)`. Ties share a rank.
- `cached`: boolean — `true` when served from the edge cache.

**Errors:** `429 RATE_LIMITED` (effectively never).

---

### 4.5 Learning (NEW — spaced-repetition opening training)

Each `(lineId, fen, move)` triple is a reviewable item. Server uses an SM-2-style schedule (the same one as the browser `srs.js`): 8 levels at `4h, 1d, 3d, 7d, 14d, 30d, 90d, 180d`; correct advances one level, incorrect resets to level 1; mastery at level 6.

#### GET /api/learn/progress
Per-line progress, due counts, and current streak.

**Auth:** Bearer.

**Response `200 OK`:**
```json
{
  "lines": [
    {
      "lineId":  "italian-game",
      "total":   42,
      "mastered": 17,
      "avgLevel": 4.2,
      "dueCount": 3
    }
  ],
  "dueCount":   5,
  "streak":     { "count": 7, "longest": 12, "lastDay": "2026-7-22" }
}
```
- `total`: items seen for this line (an unseen `(lineId, fen, move)` is not present).
- `mastered`: count at level `>= 6`.
- `avgLevel`: mean level across seen items.
- `dueCount` (per-line and global): items with `dueAt <= now`.
- `streak.lastDay`: client-local date string `YYYY-M-D` (per the browser implementation; server may normalize to ISO `YYYY-MM-DD` in a non-breaking additive change).

**Errors:** `401 UNAUTHORIZED`.

---

#### POST /api/learn/review
Submit one review. Returns the updated SRS record. Also bumps the daily streak the first time a review lands on a given day.

**Auth:** Bearer.

**Request body:**
```json
{
  "lineId":  "italian-game",
  "fen":     "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b",
  "move":    "Bc5",
  "correct": true
}
```
| Field | Type | Constraint |
|---|---|---|
| `lineId` | string | required, non-empty |
| `fen` | string | required, FEN of the position being answered from |
| `move` | string | required, SAN of the move being reviewed |
| `correct` | boolean | required |

**Response `200 OK`:**
```json
{
  "record": {
    "lineId":        "italian-game",
    "fen":           "r1bqkbnr/...",
    "move":          "Bc5",
    "level":         4,
    "reviewedAt":    1719000000000,
    "dueAt":         1719259200000,
    "correctCount":  3,
    "wrongCount":    0,
    "repetitions":   3
  },
  "streak":   { "count": 8, "longest": 12, "lastDay": "2026-7-22" }
}
```
- New item (never reviewed): starting level advances to `1` if correct, `1` if incorrect (both place into the schedule; the difference is in the counts).
- `dueAt = reviewedAt + SCHEDULE[level-1]`.

**Errors:** `401 UNAUTHORIZED`; `422 INVALID_BODY`; `429 RATE_LIMITED`.

---

#### GET /api/learn/review/due
All items currently due across all lines (the user's "review queue").

**Auth:** Bearer.

**Response `200 OK`:**
```json
{
  "items": [
    {
      "lineId": "italian-game",
      "fen":    "r1bqkbnr/...",
      "move":   "Bc5",
      "level":  3,
      "dueAt":  1718999500000,
      "lastReviewed": 1718997000000,
      "reviewCount":  3,
      "lapseCount":   1
    }
  ]
}
```
- Items with `dueAt <= now`. Ordered by `dueAt ASC` (oldest due first).
- `reviewCount` / `lapseCount`: total reps and number of resets-to-level-1.

**Errors:** `401 UNAUTHORIZED`.

---

### 4.6 Admin (requires X-Admin-Token)

All `/api/admin/*` routes require `X-Admin-Token: <ADMIN_SECRET>` (constant-time compared). User-scoped admin actions additionally require Bearer auth of an admin user (`is_admin = 1`).

#### GET /api/admin/games
List active (in-progress) games from `active_games`.

**Auth:** `X-Admin-Token`.

**Query:** `limit` (`1..100`, default `50`), `offset` (default `0`).

**Response `200 OK`:**
```json
{
  "games": [
    {
      "id":           "gm_0a1b2c3d4",
      "whiteId":      "usr_...",
      "whiteHandle":  "SwiftKnight42",
      "whiteRating":  1247,
      "blackId":      "usr_...",
      "blackHandle":  "BoldRook18",
      "blackRating":  1230,
      "timeControl":  "10+5",
      "fen":          "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b",
      "startedAt":    1719000000000,
      "lastMoveAt":   1719000010000
    }
  ],
  "limit": 50, "offset": 0
}
```
**Errors:** `401 UNAUTHORIZED` (missing/wrong admin token); `503 ADMIN_UNCONFIGURED` (no `ADMIN_TOKEN` set server-side).

---

#### GET /api/admin/games/:id
Live game state for one GameRoom.

**Auth:** `X-Admin-Token`.

**Response `200 OK`:**
```json
{
  "id":           "gm_0a1b2c3d4",
  "whiteId":      "usr_...",
  "blackId":      "usr_...",
  "fen":          "...",
  "moveCount":    14,
  "clock":        { "w": 195000, "b": 212000 },
  "startedAt":    1719000000000,
  "status":       "playing"
}
```
**Errors:** `401 UNAUTHORIZED`; `404 NOT_FOUND`; `503 ADMIN_UNCONFIGURED`.

---

#### POST /api/admin/games/:id/prank
Inject a prank into a live game (broadcasts a `prank` WS message to both clients). Logged to `prank_log`.

**Auth:** `X-Admin-Token` + Bearer (admin user).

**Request body:**
```json
{ "prank": "board_flip", "target": "black" }
```
| Field | Type | Constraint |
|---|---|---|
| `prank` | enum | `"board_flip"` \| `"piece_hide"` \| `"eval_invert"` \| `"sound_swarm"` (extensible) |
| `target` | enum | optional: `"white"` \| `"black"` \| `"both"` (default `"both"`) |

**Response `200 OK`:**
```json
{ "ok": true, "gameId": "gm_0a1b2c3d4", "prank": "board_flip", "target": "black" }
```
**Errors:** `401 UNAUTHORIZED`; `403 FORBIDDEN`; `404 NOT_FOUND`; `422 INVALID_BODY`; `503 ADMIN_UNCONFIGURED`.

---

#### GET /api/admin/users?q=
Search users by handle prefix.

**Auth:** `X-Admin-Token`.

**Query:** `q` (string, required; matches `handle LIKE q%`), `limit` (`1..100`, default `50`), `offset` (default `0`).

**Response `200 OK`:**
```json
{
  "users": [
    {
      "id":           "usr_...",
      "handle":       "SwiftKnight42",
      "rating":       1247,
      "gamesPlayed":  18,
      "isAdmin":      false,
      "isBanned":     false,
      "bannedAt":     null,
      "bannedReason": null,
      "createdAt":    1718000000000
    }
  ],
  "limit": 50, "offset": 0
}
```
**Errors:** `400 INVALID_BODY` (missing `q`); `401 UNAUTHORIZED`; `503 ADMIN_UNCONFIGURED`.

---

#### POST /api/admin/users/:id/ban
Ban a user. Subsequent authed requests from that user return `403 BANNED`.

**Auth:** `X-Admin-Token` + Bearer (admin user).

**Path params:** `id` — `usr_...`.

**Request body:**
```json
{ "reason": "cheating" }
```
| Field | Type | Constraint |
|---|---|---|
| `reason` | string | optional, free-form, recorded in `banned_reason` and `admin_audit.detail` |

**Response `200 OK`:**
```json
{ "ok": true, "id": "usr_...", "bannedAt": 1719000000000 }
```
**Errors:** `401 UNAUTHORIZED`; `403 FORBIDDEN`; `404 NOT_FOUND`; `409 ALREADY_BANNED`; `503 ADMIN_UNCONFIGURED`.

---

#### POST /api/admin/users/:id/unban
Lift a ban.

**Auth:** `X-Admin-Token` + Bearer (admin user).

**Request body:** none.

**Response `200 OK`:**
```json
{ "ok": true, "id": "usr_..." }
```
**Errors:** `401 UNAUTHORIZED`; `403 FORBIDDEN`; `404 NOT_FOUND` (or `409 NOT_BANNED` — pick one consistently during implementation); `503 ADMIN_UNCONFIGURED`.

---

#### GET /api/admin/stats
Platform-wide stats.

**Auth:** `X-Admin-Token`.

**Response `200 OK`:**
```json
{
  "users":        { "total": 1234, "banned": 5, "admins": 2 },
  "games":        { "totalSaved": 9876, "active": 3, "last24h": 421 },
  "matchmaking":  { "waiting": 12, "matches": 3 },
  "learning":     { "reviewsToday": 87, "activeLearners": 23 }
}
```
**Errors:** `401 UNAUTHORIZED`; `503 ADMIN_UNCONFIGURED`.

---

### 4.7 Health

#### GET /api/health
Unauthed liveness probe. Returns `200` with `{ ok: true, service, ts }`. Not rate-limited.

---

## 5. WebSocket protocol

### 5.1 Connection

**Upgrade request:**
```
GET /api/game/:gameId/ws?token=<token> HTTP/1.1
Upgrade: websocket
Connection: Upgrade
Origin: https://agntong.github.io
```

- `gameId`: live-game id returned by `/match/poll` (`gm_...`) or by direct GameRoom creation.
- `token`: a fresh bearer token (the WS handshake cannot set `Authorization`). **The nonce is consumed on upgrade**, so a reconnect requires `POST /api/auth/refresh` first (see §6.2).
- `Origin` must be in `ALLOWED_WS_ORIGINS`; otherwise the upgrade returns `403` before WS framing begins.
- Server applies `MAX_WS_PER_IP` (default `5`) concurrent upgrades per source IP; excess returns `429`.

**Upgrade failure codes (returned before WS):**
| Status | Code | Meaning |
|---|---|---|
| `401` | `UNAUTHORIZED` | missing/invalid/expired token, or user not in this game |
| `403` | `FORBIDDEN` | `Origin` not allow-listed; or user is banned |
| `404` | `NOT_FOUND` | `gameId` unknown or game already finalized |
| `429` | `RATE_LIMITED` | per-IP WS cap hit |

Once upgraded, the protocol is JSON-text frames only. Binary frames are rejected with `1003` (unsupported data). Both sides MUST validate every message against the schemas below and silently drop malformed ones (server logs a `warn`; client may surface a toast). Either side may send a `ping`/`pong` at any time; clients SHOULD send a `ping` every 20–30s of idleness.

### 5.2 Client → Server messages

All client messages are JSON objects with a `type` field. Unknown types are ignored.

#### move
```json
{ "type": "move", "from": "e2", "to": "e4", "promotion": null }
```
| Field | Type | Constraint |
|---|---|---|
| `from` | string | required, square `a1`–`h8` |
| `to` | string | required, square `a1`–`h8` |
| `promotion` | string \| null | optional; one of `"q"`, `"r"`, `"b"`, `"n"` when a pawn reaches the last rank; `null` otherwise |

Server validates legality against the current FEN. On accept, both clients receive a `move` broadcast. On reject, the sender receives `move_rejected` and the game state is unchanged.

#### resign
```json
{ "type": "resign" }
```
Server ends the game: sender loses, opponent wins. Both clients receive `game_over`.

#### draw_offer / draw_accept / draw_decline
```json
{ "type": "draw_offer" }
{ "type": "draw_accept" }
{ "type": "draw_decline" }
```
- `draw_offer` is forwarded to the opponent as `draw_offer`.
- `draw_accept` ends the game as a draw (`result: "draw"`, `ending: "agreement"`). It is only valid while the opponent has an outstanding offer; otherwise the server sends `move_rejected` with `reason: "no_offer"`.
- `draw_decline` clears the outstanding offer on the server; both clients get `draw_declined` (informational).

#### chat
```json
{ "type": "chat", "text": "good game" }
```
| Field | Type | Constraint |
|---|---|---|
| `text` | string | required, `1..500` chars after trim; server truncates longer input |

Server re-broadcasts to both clients as `chat` (with the sender's `handle`). Profanity/PII filtering is a server-side concern and may mutate `text`; clients must not assume echo.

#### ping
```json
{ "type": "ping" }
```
Server replies with `pong` on the same socket.

### 5.3 Server → Client messages

#### game_start
Sent once upon successful upgrade to both players, before any other message.
```json
{
  "type":        "game_start",
  "gameId":      "gm_0a1b2c3d4",
  "opponent":    { "userId": "usr_...", "handle": "BoldRook18", "rating": 1230 },
  "color":       "w",
  "timeControl": "10+5",
  "initialClock":{ "w": 600000, "b": 600000 },
  "startedAt":   1719000000000
}
```
- `color`: the side the receiving client plays.
- `timeControl`: `<minutes>+<increment-seconds>`; `"10+5"` → 10 minutes base, 5s increment per move.
- `initialClock`: starting milliseconds for each side.

#### move (broadcast)
```json
{
  "type": "move",
  "from": "e2", "to": "e4",
  "san":  "e4",
  "fen":  "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
  "clock": { "w": 295000, "b": 300000 },
  "moveNumber": 1,
  "by": "w"
}
```
- `san`: Standard Algebraic Notation, server-canonicalized.
- `fen`: full position after the move (full move number, halfmove clock, en passant square, castling rights).
- `clock`: milliseconds remaining for each side **after** applying the move and increment.
- `by`: which color made the move (`"w"` / `"b"`).

#### move_rejected
```json
{ "type": "move_rejected", "reason": "illegal", "from": "e2", "to": "e5" }
```
- `reason` enum: `"illegal"`, `"not_your_turn"`, `"game_over"`, `"no_offer"` (misused draw message), `"malformed"`. The game state is unchanged; the client rolls back any optimistic local move.

#### game_over
```json
{
  "type": "game_over",
  "result":       "win",
  "ending":       "checkmate",
  "winner":       "w",
  "finalFen":     "...",
  "finalClock":   { "w": 0, "b": 4231 },
  "ratingDelta":  24,
  "newRating":    1271,
  "pgn":          "1. e4 e5 2. Nf3 ...",
  "endedAt":      1719000600000
}
```
- `result`: from the receiving client's perspective — `"win"`, `"loss"`, `"draw"`.
- `ending` enum: `"checkmate"`, `"stalemate"`, `"resignation"`, `"timeout"`, `"draw"`, `"agreement"`, `"abandoned"`, `"disconnect"`.
- `winner`: `"w"`, `"b"`, or `null` (draws).
- `ratingDelta`: signed integer change to the receiver's rating (0 for draws, or while provisionally rated).
- `newRating`: receiver's rating after the game.
- Server persists the finished game and removes the GameRoom after both clients ack or after a short grace period. The server, not the client, is authoritative for multiplayer ratings; clients do not POST multiplayer games to `/api/games`.

#### draw_offer
```json
{ "type": "draw_offer", "by": "b" }
```
The opponent (`by`) has offered a draw. Receiver responds with `draw_accept` or `draw_decline`.

#### draw_declined
```json
{ "type": "draw_declined", "by": "w" }
```
The opponent declined the receiver's outstanding offer.

#### chat
```json
{ "type": "chat", "handle": "BoldRook18", "text": "good game", "ts": 1719000010000 }
```

#### opponent_disconnected
```json
{ "type": "opponent_disconnected", "reconnectIn": 60 }
```
The opponent's WS closed (network blip, tab close, etc.). `reconnectIn` is the grace period in seconds during which the opponent may reconnect and the game continues. If they do not reconnect, the server sends `game_over` with `ending: "disconnect"` (or `"abandoned"` depending on clock state).

#### opponent_reconnected
```json
{ "type": "opponent_reconnected" }
```
The opponent re-established their WS. The server re-broadcasts the current `fen` and `clock` to both clients as a `sync` message (see below) so clocks resync after the gap.

#### sync
```json
{
  "type": "sync",
  "fen":  "...",
  "clock": { "w": 195000, "b": 212000 },
  "moveNumber": 14,
  "toMove": "w"
}
```
Authoritative snapshot — sent on reconnect, on `pong` after a pause (optional), or whenever the server detects client desync.

#### prank
```json
{ "type": "prank", "prank": "board_flip", "durationMs": 5000, "target": "black" }
```
Admin-injected (via `/api/admin/games/:id/prank`). `prank` enum mirrors the admin endpoint. `target` is which client(s) should apply it (`"white"`, `"black"`, `"both"`). `durationMs`: how long the client should keep the effect; `0` means until manually cleared.

#### pong
```json
{ "type": "pong" }
```

### 5.4 Close codes

| Code | Meaning |
|---|---|
| `1000` | Normal close (game ended, server-initiated). |
| `1003` | Unsupported data (binary frame). |
| `1008` | Policy violation (protocol violation after upgrade). |
| `1011` | Internal server error. |
| `4001` | Token invalid/expired mid-session. Client must refresh and reconnect. |
| `4002` | Game finalized; no longer accepting messages. |
| `4003` | Kicked by admin. |

---

## 6. Scenario walkthroughs

### 6.1 Anonymous user plays a bot, saves the game
1. `POST /api/auth/anonymous` → `{ userId, handle, token, rating: 1200 }`. Client persists the token.
2. Client plays locally against Stockfish. Game ends.
3. Client computes accuracy/ELO/buckets locally (mirrored math).
4. `POST /api/games` with the move list, opponent `{kind:"bot", name, rating}`, `color`, `result`, `ending`. Server applies the Glicko-1 update, returns `{ id, game }` (`201`).
5. `GET /api/auth/me` → refreshed rating/wins/losses.
6. `GET /api/games?limit=20` → history. `GET /api/games/stats` → aggregates.

### 6.2 Two humans play via matchmaking
1. Both `POST /api/auth/anonymous` (or refresh).
2. Alice `POST /api/match/queue { rating, peerId, timeControl:"10+5" }` → `{ ticketId, status:"waiting" }`.
3. Alice `GET /api/match/poll/:ticketId` (long-poll). Bob does steps 2–3 in parallel.
4. Server matches → both polls return `{ status:"matched", game:{ gameId, me, opponent, ... } }`.
5. **Both clients `POST /api/auth/refresh` first** — the queue/poll nonce is consumed; the WS upgrade needs a fresh nonce.
6. Both clients open `GET /api/game/:gameId/ws?token=<fresh>`. Server validates token, `Origin`, and that the user is a participant; upgrades.
7. Both receive `game_start`, then exchange `move`/`move_rejected`/`draw_offer`/`chat` per the protocol.
8. Game ends → server broadcasts `game_over` with `ratingDelta`/`newRating`, persists, closes the sockets (`1000`). Clients do **not** POST the result; the server is authoritative for rated multiplayer games.

### 6.3 Invite link flow
1. Host `POST /api/auth/anonymous` → token.
2. Host `POST /api/match/invite { peerId, timeControl }` → `{ code:"7KQ3HM", expiresAt }`. Host shares `https://.../?join=7KQ3HM`.
3. Guest opens the link, `GET /api/match/invite/7KQ3HM` → `{ status:"available", creatorPeerId, creatorRating, timeControl }`.
4. Guest `POST /api/match/invite/7KQ3HM/claim` → atomic. First claim `200`; any concurrent claim `409 ALREADY_TAKEN`.
5. Both sides now have each other's `peerId` and open a GameRoom via `POST /api/games`-equivalent live-game creation (or via the WS upgrade directly if both present `gameId`). The live game proceeds as in §6.2.

### 6.4 Edge cases that shape the contract
- **Partial failure on game save:** network drops after the server commits. The client retries `POST /api/games` with the same payload → `200 { duplicate:true }` (content hash), no double-count. This is why dedup is contractual.
- **WS reconnect mid-game:** token nonce consumed on first upgrade. The client must `POST /api/auth/refresh` and reconnect with the new token within `reconnectIn`. On reconnect, both clients get `opponent_reconnected` + `sync`.
- **Concurrent invite claim:** two guests click the same link. Conditional `UPDATE ... WHERE taken_at IS NULL` → exactly one `200`, the rest `409`. No double-connection.
- **Banned user mid-session:** `authMiddleware` checks `is_banned` on every authed REST call and on WS upgrade. A user banned mid-game sees their next request fail with `403 BANNED` and their WS closed with `4003`.
- **Long-poll under Workers ceiling:** server caps `/match/poll` at 25s; clients must re-poll on `status:"waiting"`. There is no infinite hold.

---

## 7. Evolution plan

### 7.1 Additive, non-breaking changes (ship freely under `/api`)
- New optional request fields (e.g. `match/queue { "seekRange": 100 }`).
- New response fields (e.g. `games { "tournamentId": null }`). Clients ignore unknown keys.
- New endpoints (e.g. `GET /api/learn/lines/italian-game`).
- New error codes — clients must treat unknown codes in a known class (4xx/5xx) by the HTTP status.
- New WS message `type`s — clients ignore unknown types.
- Adding `cursor` pagination alongside `limit/offset` (additive `nextCursor` field).

### 7.2 Breaking changes (require `/api/v2/` + deprecation)
- Renaming or removing any field (e.g. `ratingRd` → `rd`).
- Changing a field's type or semantics (e.g. `accuracy` from `0..100` to `0..1`).
- Removing an endpoint.
- Changing `result` perspective from "the authed user" to "white".
- Changing the error envelope shape.

### 7.3 Deprecation policy
When `/api/v2/` ships:
1. `/api/` continues to run unchanged for at least 6 months.
2. Deprecated v1 fields/endpoints gain a `Sunset` response header and a `Deprecation: true` header.
3. v1 is removed only after telemetry shows <1% traffic on the deprecated surface, or after the announced sunset date, whichever is later.

### 7.4 Likely v2 candidates (not committed)
- Account linkage (email/OAuth) replacing pure-anonymous auth.
- Cursor pagination on `GET /api/games`.
- Tournament/swiss endpoints under `/api/v2/tournaments`.
- Server-side anti-cheat signals exposed on the admin game-state endpoint.
- Replacing single-use-nonce tokens with revocable refresh tokens, removing the WS-reconnect friction in §6.2.

---

## 8. Open questions (need product/consumer input before locking)

1. **Multiplayer rating attribution.** Should the server be the sole authority for live-game ratings (the assumption in §6.2), or do clients still POST their own copy of the game for redundancy? Current `/api/games` POST treats the caller's result as truth — that is fine for bot games and risky for adversarial multiplayer.
2. **Invite claim auth.** `POST /match/invite/:code/claim` is anonymous today. Should it require Bearer so claims are attributable and rate-limitable per user?
3. **Admin unban response code.** `404` vs `409 NOT_BANNED` for unbanning a non-banned user — pick one.
4. **WS close vs. `game_over` on disconnect timeout.** When `reconnectIn` elapses, is the finalized game `ending:"disconnect"` or `"abandoned"`? The contract should pick one and tie it to clock state.
5. **Learning streak date format.** Client uses local-date `YYYY-M-D` (no zero-padding). Should the server normalize to ISO `YYYY-MM-DD`, accepting the breaking field-shape change, or keep parity and add a normalized field additively?
6. **Rate-limit budget ownership.** The numbers in §3.4 are placeholders; need confirmation from ops.
7. **Admin prank target validation.** Should `target` default to `"both"` or require explicit specification to avoid accidental cross-player effects?

---

## Appendix A — Error code reference

| Code | HTTP | Where |
|---|---|---|
| `INVALID_BODY` | 400 / 422 | bad JSON / failed semantic validation |
| `UNAUTHORIZED` | 401 | missing/invalid/expired token, or missing admin token |
| `FORBIDDEN` | 403 | not your resource; bad WS origin; non-admin user on admin route |
| `BANNED` | 403 | `is_banned = 1` |
| `NOT_FOUND` | 404 | resource does not exist |
| `ALREADY_TAKEN` | 409 | invite already claimed |
| `ALREADY_BANNED` | 409 | ban a banned user (proposed) |
| `INVALID_CODE` | 422 | invite code format mismatch |
| `RATE_LIMITED` | 429 | bucket exhausted |
| `INTERNAL` | 500 | unhandled server error |
| `MISCONFIGURED` | 500 | `AUTH_SECRET` unset |
| `CODE_COLLISION` | 500 | invite allocation failed |
| `ADMIN_UNCONFIGURED` | 503 | `ADMIN_TOKEN` unset |

## Appendix B — ID prefixes

| Prefix | Resource | Example |
|---|---|---|
| `usr_` | user | `usr_q3rf7n0p2mwxb1ca` |
| `tok_` | auth token | `tok_usr_....<ts>.<nonce>.<mac>` |
| `gme_` | persisted game | `gme_a1b2c3d4e5f6` |
| `gm_` | live GameRoom game | `gm_0a1b2c3d4` |
| `tkt_` | matchmaking ticket | `tkt_a1b2c3d4e` |
| `peer_` | WebRTC peer id (client-generated) | `peer_abc123...` |

## Appendix C — Time-control format

`<base-minutes>+<increment-seconds>`, both non-negative integers.
- `"10+5"` — 10 minutes base, 5s increment per move.
- `"3+2"`, `"5+0"`, `"15+10"` — common presets.
- `null` means "any/no preference" in matchmaking and "untimed" in GameRoom (clocks always report the full allotment).

Server stores `timeControl` verbatim as a string; it does not parse into a structured object in v1. A structured `{ baseMs, incrementMs }` form would be an additive v2 companion field.
