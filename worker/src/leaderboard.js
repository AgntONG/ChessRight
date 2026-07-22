const CACHE_TTL = 60;
const CACHE_KEY = 'https://cache.local/chessright/leaderboard';

export function registerLeaderboardRoutes(app) {
  app.get('/api/leaderboard', async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100', 10) || 100, 1), 500);
    const cache = caches.default;
    const cached = await cache.match(new Request(CACHE_KEY));
    if (cached) {
      const data = await cached.json();
      if (data.limit >= limit) {
        return c.json({ entries: data.entries.slice(0, limit), cached: true });
      }
    }
    const result = await c.env.DB.prepare(
      `SELECT handle, rating, games_played,
              RANK() OVER (ORDER BY rating DESC) as rank
       FROM users
       WHERE games_played >= 5
       ORDER BY rating DESC
       LIMIT ?`
    ).bind(limit).all();
    const entries = (result.results || []).map((r) => ({
      rank: r.rank,
      handle: r.handle,
      rating: r.rating,
      gamesPlayed: r.games_played
    }));
    const body = JSON.stringify({ entries, cached: false, limit });
    const res = new Response(body, { headers: {
      'content-type': 'application/json',
      'cache-control': `max-age=${CACHE_TTL}`
    }});
    c.executionCtx.waitUntil(cache.put(new Request(CACHE_KEY), res.clone()));
    return res;
  });
}
