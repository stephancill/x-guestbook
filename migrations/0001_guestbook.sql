CREATE TABLE login_attempts (
  state TEXT PRIMARY KEY,
  poll_hash TEXT NOT NULL,
  launch_hash TEXT,
  callback_hash TEXT,
  verifier TEXT,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT,
  error TEXT
);

CREATE INDEX login_expiry ON login_attempts(expires_at);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE INDEX session_expiry ON sessions(expires_at);

CREATE TABLE entries (
  room TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  username TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  message TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  PRIMARY KEY(room, user_id)
);

CREATE INDEX book_entries ON entries(room, signed_at DESC);
