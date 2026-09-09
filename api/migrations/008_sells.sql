-- The exit, recorded like the entry.
--
-- Kept separate from `buys` rather than as a signed amount on one table. A buy
-- and a sell are different shapes: a buy has fees and one input amount, a sell
-- has neither and can cover any subset of the legs. Folding them together would
-- mean every volume query having to remember which sign it wanted, and the
-- first one that forgot would quietly report a basket as twice as busy as it is.
CREATE TABLE sells (
  tx         TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  index_id   INTEGER NOT NULL,
  seller     TEXT NOT NULL,
  legs       INTEGER NOT NULL,
  amount_out TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX sells_by_index ON sells (index_id, block DESC);
CREATE INDEX sells_by_seller ON sells (seller, block DESC);
CREATE INDEX sells_recent ON sells (block DESC);
