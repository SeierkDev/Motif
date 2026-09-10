-- Running totals for the routes that used to add up every buy on every request.
--
-- The leaderboard, the creator routes, a motif's page and /v1/stats each
-- aggregated the whole buys table on every cache miss, a cost that grew with
-- every trade and, on a synchronous database, stalled every other request
-- while it ran. These hold the same sums, kept current as rows arrive.
--
-- Rebuilt from buys and sells on every boot (totals.ts), so nothing stored
-- here can be wrong for longer than one restart. Exact money stays TEXT; the
-- REAL columns are only for ordering, as SUM(CAST(... AS REAL)) was before.
CREATE TABLE index_totals (
  index_id    INTEGER PRIMARY KEY,
  buys        INTEGER NOT NULL DEFAULT 0,
  volume      TEXT    NOT NULL DEFAULT '0',
  fees        TEXT    NOT NULL DEFAULT '0',
  volume_sort REAL    NOT NULL DEFAULT 0,
  fees_sort   REAL    NOT NULL DEFAULT 0,
  holders     INTEGER NOT NULL DEFAULT 0,
  last_buy_ts INTEGER
);
CREATE INDEX index_totals_volume ON index_totals (volume_sort DESC);
CREATE INDEX index_totals_fees ON index_totals (fees_sort DESC);

-- Distinct buyers per motif, so a holder count moves only on a first buy.
CREATE TABLE index_buyers (
  index_id INTEGER NOT NULL,
  buyer    TEXT    NOT NULL,
  PRIMARY KEY (index_id, buyer)
);

-- Distinct buyers overall, for /v1/stats.
CREATE TABLE buyers (
  buyer TEXT PRIMARY KEY
);

-- The site wide sums, one row.
CREATE TABLE totals (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  buys       INTEGER NOT NULL DEFAULT 0,
  volume_in  TEXT    NOT NULL DEFAULT '0',
  sells      INTEGER NOT NULL DEFAULT 0,
  volume_out TEXT    NOT NULL DEFAULT '0'
);
