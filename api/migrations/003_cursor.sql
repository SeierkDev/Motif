-- Where the indexer got to. One row, so a restart resumes rather than
-- rescanning six million blocks.
CREATE TABLE cursor (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_block    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO cursor (id, last_block, updated_at) VALUES (1, 0, 0);
