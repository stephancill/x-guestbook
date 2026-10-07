CREATE TABLE embed_access (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX embed_expiry ON embed_access(expires_at);
