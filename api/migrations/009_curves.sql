-- Basket tokens, read from BasketFactory.Launched.
--
-- The static half comes from the log and never changes: a curve's index, vault,
-- pool, threshold and metadata are all fixed at construction and there is no
-- setter for any of them anywhere in the contracts.
--
-- The moving half (raised, sold, graduated) is polled rather than derived from
-- the curve's own Bought and Sold logs. Both would work, and polling was chosen
-- because it cannot drift: a missed log leaves a permanent hole in a derived
-- total, and the number this drives is a progress bar somebody is watching to
-- decide whether to buy. A poll is either current or stale, and stale is
-- visible because `state_at` is served alongside it.
CREATE TABLE curves (
  curve           TEXT PRIMARY KEY,
  index_id        INTEGER NOT NULL,
  creator         TEXT NOT NULL,
  vault           TEXT NOT NULL,
  pool            TEXT NOT NULL,
  threshold       TEXT NOT NULL,
  creator_fee_bps INTEGER NOT NULL,
  leg_count       INTEGER NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  symbol          TEXT NOT NULL DEFAULT '',
  description     TEXT NOT NULL DEFAULT '',
  block           INTEGER NOT NULL,
  tx              TEXT NOT NULL,
  ts              INTEGER NOT NULL DEFAULT 0,

  -- Money as decimal strings, never REAL. SUM(CAST(x AS REAL)) loses the low
  -- bits above 2^53 and these are 18 decimal token amounts.
  raised          TEXT NOT NULL DEFAULT '0',
  sold            TEXT NOT NULL DEFAULT '0',
  supply          TEXT NOT NULL DEFAULT '0',
  graduated       INTEGER NOT NULL DEFAULT 0,
  -- When the moving half was last read. Null means never, which is not zero.
  state_at        INTEGER
);

CREATE INDEX curves_by_creator ON curves (creator, block DESC);
CREATE INDEX curves_by_index ON curves (index_id);
CREATE INDEX curves_recent ON curves (block DESC);
