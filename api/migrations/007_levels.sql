-- What a motif is actually worth over time.
--
-- The leaderboard could rank by volume and creator earnings, neither of which
-- says whether a motif is any good. This is the missing number, and it is also
-- the one thing here that cannot be backfilled: once a price has passed, that
-- motif's level at that moment is gone for everyone, including us.

CREATE TABLE price_snapshots (
  token   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  price18 TEXT NOT NULL,
  PRIMARY KEY (token, at)
);
CREATE INDEX prices_recent ON price_snapshots (token, at DESC);

-- The weighted price of one unit of the basket when it was first observed.
-- Every level is quoted against this, so a motif starts at 100 whenever it
-- launched rather than against some shared epoch.
CREATE TABLE motif_basis (
  index_id INTEGER PRIMARY KEY,
  basis18  TEXT NOT NULL,
  at       INTEGER NOT NULL
);

CREATE TABLE motif_levels (
  index_id INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  level18  TEXT NOT NULL,
  PRIMARY KEY (index_id, at)
);
CREATE INDEX levels_recent ON motif_levels (index_id, at DESC);
