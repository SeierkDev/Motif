-- Published indexes and their legs, read from IndexCreated.
CREATE TABLE indexes (
  id              INTEGER PRIMARY KEY,
  creator         TEXT NOT NULL,
  creator_fee_bps INTEGER NOT NULL,
  input           TEXT NOT NULL,
  leg_count       INTEGER NOT NULL,
  block           INTEGER NOT NULL,
  tx              TEXT NOT NULL
);

CREATE TABLE legs (
  index_id   INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  token      TEXT NOT NULL,
  fee        INTEGER NOT NULL,
  weight_bps INTEGER NOT NULL,
  PRIMARY KEY (index_id, position)
);

CREATE INDEX legs_by_token ON legs (token);
