-- Indexes for the feed's own ordering, which is (block, log_index) rather than
-- block alone.
--
-- Two buys can land in one block, and the cursor `/v1/buys` hands out has to be
-- able to name a position *inside* a block or the next page starts after the
-- whole block and the rest of it is never served. That was measured on the
-- fixture: three buys, two of them in one block, paged with limit=1, and one
-- row came back invisible.
--
-- `sells_recent` already existed on (block DESC) and is left alone; this adds
-- the tiebreaker column to both, so the ordering the server asks for is the
-- ordering an index can supply and the sort is not a scan.
CREATE INDEX IF NOT EXISTS buys_recent  ON buys  (block DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS sells_paged  ON sells (block DESC, log_index DESC);
