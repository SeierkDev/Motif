-- Every burn the burner has done, read off its own `Burned` log.
--
-- Amounts are decimal strings for the same reason every other amount here is:
-- they are 18 decimal fixed point, and SQLite's numbers go through a double
-- that loses the low bits above 2^53.
--
-- `motif_burned` can exceed `motif_bought`. The contract burns everything it
-- holds, so MOTIF somebody sent to it before a call is destroyed along with
-- that call's purchase, and both figures are kept so the difference is visible.
CREATE TABLE burns (
  tx           TEXT    NOT NULL,
  log_index    INTEGER NOT NULL,
  caller       TEXT    NOT NULL,
  usdg_in      TEXT    NOT NULL,
  eth_spent    TEXT    NOT NULL,
  motif_bought TEXT    NOT NULL,
  motif_burned TEXT    NOT NULL,
  block        INTEGER NOT NULL,
  ts           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tx, log_index)
);
CREATE INDEX burns_recent ON burns (block DESC, log_index DESC);
