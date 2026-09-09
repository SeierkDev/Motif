-- Every purchase, keyed on the log rather than the transaction, so one
-- transaction containing two buys cannot silently collapse into one row.
CREATE TABLE buys (
  tx           TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  index_id     INTEGER NOT NULL,
  buyer        TEXT NOT NULL,
  amount_in    TEXT NOT NULL,
  creator_fee  TEXT NOT NULL,
  protocol_fee TEXT NOT NULL,
  block        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
);

CREATE INDEX buys_by_index ON buys (index_id, block DESC);
CREATE INDEX buys_by_buyer ON buys (buyer, block DESC);

CREATE TABLE rebalances (
  tx           TEXT NOT NULL,
  log_index    INTEGER NOT NULL,
  holder       TEXT NOT NULL,
  index_id     INTEGER NOT NULL,
  drift_before INTEGER NOT NULL,
  block        INTEGER NOT NULL,
  PRIMARY KEY (tx, log_index)
);

CREATE INDEX rebalances_by_holder ON rebalances (holder, block DESC);
