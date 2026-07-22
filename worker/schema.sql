CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  rating INTEGER NOT NULL DEFAULT 1200,
  rating_rd INTEGER NOT NULL DEFAULT 350,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_game_at INTEGER
);
CREATE INDEX idx_users_rating ON users(rating DESC);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  opponent_kind TEXT NOT NULL,
  opponent_name TEXT NOT NULL,
  opponent_rating INTEGER,
  color TEXT NOT NULL,
  result TEXT NOT NULL,
  ending TEXT NOT NULL,
  pgn TEXT NOT NULL,
  moves_json TEXT NOT NULL,
  accuracy REAL,
  estimated_elo INTEGER,
  buckets_json TEXT,
  duration_ms INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_games_user ON games(user_id, created_at DESC);
CREATE UNIQUE INDEX idx_games_user_hash ON games(user_id, hash);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  creator_rating INTEGER NOT NULL,
  creator_peer_id TEXT NOT NULL,
  time_control TEXT,
  created_at INTEGER NOT NULL,
  taken_at INTEGER,
  FOREIGN KEY (creator_id) REFERENCES users(id)
);
