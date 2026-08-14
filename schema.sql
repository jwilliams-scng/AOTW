PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT,
  opens_at TEXT,
  closes_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT NOT NULL,
  name TEXT NOT NULL,
  school TEXT NOT NULL,
  class_year TEXT,
  performance TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id TEXT NOT NULL,
  candidate_id INTEGER NOT NULL,
  voter_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
  FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
  UNIQUE (poll_id, voter_hash)
);

CREATE INDEX IF NOT EXISTS idx_candidates_poll ON candidates(poll_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_votes_candidate ON votes(candidate_id);

INSERT OR REPLACE INTO polls
  (id, title, subtitle, opens_at, closes_at, active)
VALUES
  ('test-2026', 'SCNG Athlete of the Week', 'Vote for the top performance of the week.', '2026-08-01T07:00:00Z', '2026-12-31T20:00:00Z', 1);

DELETE FROM candidates WHERE poll_id = 'test-2026';
INSERT INTO candidates (poll_id, name, school, class_year, performance, sort_order) VALUES
  ('test-2026', 'Jane Smith', 'Mater Dei', 'Sr.', '225 total yards and three touchdowns.', 1),
  ('test-2026', 'John Jones', 'Centennial', 'Jr.', '12 tackles, three sacks and a forced fumble.', 2);
