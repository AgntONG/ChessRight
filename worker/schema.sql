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

CREATE TABLE IF NOT EXISTS prank_log (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  prank_type TEXT NOT NULL,
  game_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_prank_log_target ON prank_log(target_id, created_at DESC);
CREATE INDEX idx_prank_log_admin ON prank_log(admin_id, created_at DESC);

CREATE TABLE IF NOT EXISTS learning_progress (
  user_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  fen TEXT NOT NULL,
  move TEXT NOT NULL,
  level INTEGER DEFAULT 1,
  due_at INTEGER,
  last_reviewed INTEGER,
  review_count INTEGER DEFAULT 0,
  lapse_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, line_id, fen, move)
);
CREATE INDEX idx_learning_due ON learning_progress(user_id, due_at);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT,
  game_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_admin ON admin_audit(admin_id, created_at DESC);
CREATE INDEX idx_audit_target ON admin_audit(target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS active_games (
  id TEXT PRIMARY KEY,
  white_id TEXT NOT NULL,
  white_handle TEXT NOT NULL,
  white_rating INTEGER NOT NULL,
  black_id TEXT NOT NULL,
  black_handle TEXT NOT NULL,
  black_rating INTEGER NOT NULL,
  time_control TEXT,
  fen TEXT,
  started_at INTEGER NOT NULL,
  last_move_at INTEGER
);

CREATE TABLE IF NOT EXISTS seen_nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_nonce_expires ON seen_nonces(expires_at);

CREATE TABLE IF NOT EXISTS ws_connections (
  ip TEXT NOT NULL,
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ip, game_id, user_id)
);
CREATE INDEX idx_wsconn_ip ON ws_connections(ip);

ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN is_banned INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN banned_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_users_is_admin ON users(is_admin) WHERE is_admin = 1;
