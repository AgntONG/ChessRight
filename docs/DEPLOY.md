# Deploy

ChessRight is two separate deployments on a single Cloudflare account:

1. **Backend** — a Worker with a D1 database and a Durable Object. Serves `/api/*`.
2. **Frontend** — a Cloudflare Pages project serving the static `web/` directory.

Both fit entirely in the Cloudflare free tier. Total monthly cost for a hobby deployment is $0; for typical traffic, well under the free quotas.

## Prerequisites

- A Cloudflare account (the free plan is sufficient).
- Node.js 18 or newer.
- The Wrangler CLI. Either install it globally (`npm install -g wrangler`) or invoke it via `npx wrangler ...` as shown below.

Verify Wrangler is available:

```bash
npx wrangler --version
```

## Part 1 — Backend (Worker + D1)

All commands run from the `worker/` directory.

### 1. Install dependencies

```bash
cd worker
npm install
```

### 2. Authenticate with Cloudflare

```bash
npx wrangler login
```

This opens a browser window. Authorize Wrangler to act on your Cloudflare account. The session is cached in your user profile; you only need to do this once per machine.

### 3. Create the D1 database

```bash
npx wrangler d1 create chessright
```

The command output ends with a block like this:

```
[[d1_databases]]
binding = "DB"
database_name = "chessright"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the `database_id` value. You will need it in the next step.

### 4. Wire the database into `wrangler.toml`

Open `worker/wrangler.toml` and replace the placeholder `database_id`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "chessright"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # ← paste yours here
```

### 5. Apply the schema

For **local development**:

```bash
npx wrangler d1 execute chessright --file=./schema.sql --local
```

For **production**:

```bash
npx wrangler d1 execute chessright --file=./schema.sql --remote
```

The schema uses `CREATE TABLE IF NOT EXISTS`, so re-running is safe. To migrate later, append new statements to `schema.sql` with a version comment at the top and re-run the command.

### 6. Set the HMAC auth secret

The Worker signs anonymous tokens with `AUTH_SECRET`. Generate a strong random string and put it in Worker secrets (not in `wrangler.toml` — secrets are not committed to source):

```bash
# Generate a 256-bit hex string
openssl rand -hex 32

# Store it
npx wrangler secret put AUTH_SECRET
# Paste the hex string when prompted
```

If you don't have `openssl`, any sufficiently long random string works (e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).

### 7. Set the CORS origin

The Worker rejects cross-origin requests unless they match `CORS_ORIGIN`, which lives in the `[vars]` section of `wrangler.toml`. This is a var, not a secret, because it is not sensitive:

```toml
[vars]
CORS_ORIGIN = "https://chessright.pages.dev"   # use your real Pages URL once you have one
```

For initial deploy you can leave the default `http://localhost:8785`; come back and update this after Part 2 produces your Pages URL.

### 8. Deploy the Worker

```bash
npx wrangler deploy
```

The output prints your Worker URL, something like:

```
https://chessright-api.<your-subdomain>.workers.dev
```

Note it. You will reference it from the frontend.

### 9. Verify

```bash
curl https://chessright-api.<your-subdomain>.workers.dev/api/leaderboard
```

A fresh deployment returns an empty leaderboard:

```json
{"leaderboard":[]}
```

If you get a CORS error from `curl`, ignore it — `curl` does not send an `Origin` header. Errors here are usually: wrong `database_id`, missing `AUTH_SECRET`, or a typo in `wrangler.toml`. Check `npx wrangler tail` for live logs.

## Part 2 — Frontend (Pages)

All commands run from the `web/` directory.

### 1. Deploy via Wrangler

```bash
cd web
npx wrangler pages deploy . --project-name chessright
```

The first deploy creates the project. Note the URL that Wrangler prints, e.g. `https://chessright.pages.dev`.

Alternatively, connect your GitHub repo to Cloudflare Pages in the dashboard for automatic deploys on push. The build command is empty (no bundler) and the output directory is `.` (the `web/` directory itself).

### 2. Update the Worker's CORS origin

Return to `worker/`, edit `wrangler.toml` to allow the Pages origin, and redeploy:

```bash
# In worker/wrangler.toml
[vars]
CORS_ORIGIN = "https://chessright.pages.dev"   # your real Pages URL

# Redeploy
npx wrangler deploy
```

Note: `CORS_ORIGIN` is a `[vars]` entry, not a secret. Do not use `wrangler secret put` for it — that would create a secret with the same name and shadow the var, with no way to set it to the value you actually want.

### 3. Point the frontend at the Worker

Open `web/scripts/play/net.js` and set `API_BASE` to your Worker URL (the default points at `http://localhost:8787` for local dev). Redeploy the frontend:

```bash
cd web
npx wrangler pages deploy . --project-name chessright
```

### 4. Verify

Open your Pages URL, click **Play**, and start a bot game. A successful bot game confirms the engine loaded and the board works. To verify the full stack, open the page in a second browser (or send the URL to a friend), enter the ranked queue from both, and confirm they pair.

## Custom domain (optional)

Once both halves are deployed on `*.pages.dev` and `*.workers.dev` you can put them on your own domain.

1. **Pages custom domain.** In the Cloudflare dashboard → Pages → your project → **Custom domains** → add `chessright.yourdomain.com`. Cloudflare provisions TLS automatically when the domain is on a Cloudflare zone.
2. **Worker route.** In the dashboard → Workers → your Worker → **Triggers** → **Routes** → add `api.yourdomain.com/*` pointing at the Worker. (Requires the domain to be on a Cloudflare zone.)
3. **Update `API_BASE`** in `web/scripts/play/net.js` to `https://api.yourdomain.com`.
4. **Update `CORS_ORIGIN`** in `worker/wrangler.toml` to `https://chessright.yourdomain.com`.
5. **Redeploy both** — Worker (`npx wrangler deploy`) and Pages (`npx wrangler pages deploy .`).

## Cost

Everything fits inside the Cloudflare free tier:

| Resource        | Free quota                          | ChessRight's footprint                                |
|-----------------|-------------------------------------|-------------------------------------------------------|
| Workers         | 100k requests/day                   | A typical game uses ~10 API calls                     |
| D1              | 5M reads, 100k writes/day           | Leaderboard cached; games write on finish only        |
| Pages           | Unlimited requests, 500 builds/mo   | Static assets; one build per deploy                   |
| Durable Objects | 100k requests/day                   | One DO, hot only during active matchmaking            |
| WebRTC          | Free                                | Peer-to-peer traffic does not touch Cloudflare        |

You would need to be on the order of tens of thousands of daily active users before approaching a paid tier.

## Maintenance

- **Live Worker logs:** `npx wrangler tail` streams console output and exceptions.
- **D1 backups:** `npx wrangler d1 backup create chessright`. Restore via `npx wrangler d1 backup restore <backup-id>`.
- **Inspect D1 data:**
  ```bash
  npx wrangler d1 execute chessright --remote --command "SELECT handle, rating FROM users ORDER BY rating DESC LIMIT 10"
  ```
- **Schema migrations:** append SQL to `schema.sql`, add a version comment at the top, re-run the `d1 execute --file` command. There is no migration tool — the schema is small enough that additive changes are sufficient.
- **Rotating `AUTH_SECRET`:** generate a new value with `openssl rand -hex 32`, `npx wrangler secret put AUTH_SECRET`, and redeploy. Note: this invalidates all existing anonymous tokens; users are issued new ones on their next visit but their `localStorage` profile is re-linked by user ID.
- **Updating Stockfish:** drop the new `stockfish.js` + `.wasm` into `web/assets/stockfish/`. The engine wrapper in `engine.js` loads a fixed path; no code change needed unless the new build changes its UCI protocol.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl /api/leaderboard` returns 500 | D1 schema not applied, or wrong `database_id` | Re-run `d1 execute --file=./schema.sql --remote`; verify `database_id` matches the created DB |
| Frontend can't reach Worker (CORS) | `CORS_ORIGIN` in `wrangler.toml` doesn't match your Pages URL | Update `[vars]` and `npx wrangler deploy` |
| Matchmaking hangs forever | Only one player in queue, or DO migration not applied | Check `npx wrangler tail`; verify `MATCH_QUEUE` binding and `[[migrations]]` block in `wrangler.toml` |
| Bot game button disabled | Stockfish `.wasm` failed to load (404 or wrong MIME) | Confirm `web/assets/stockfish/` contains both files and Pages serves `.wasm` with `application/wasm` (it does by default) |
| Rating not updating after game | Result POST rejected (hash mismatch or auth failure) | Check Worker logs; ensure both clients computed the same move list |
