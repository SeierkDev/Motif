-- "Launched 4 minutes ago" needs a wall clock, not a block height. This chain
-- returns blockTimestamp on the log itself, so it costs no extra call.
ALTER TABLE indexes ADD COLUMN ts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE buys ADD COLUMN ts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rebalances ADD COLUMN ts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX indexes_by_ts ON indexes (ts DESC);
CREATE INDEX buys_by_ts ON buys (ts DESC);
