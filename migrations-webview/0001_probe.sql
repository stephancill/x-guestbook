CREATE TABLE probe_runs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE probe_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES probe_runs(id),
  received_at INTEGER NOT NULL,
  event TEXT NOT NULL
);
CREATE INDEX probe_events_run ON probe_events(run_id,id);
