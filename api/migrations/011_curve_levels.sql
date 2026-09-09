-- What a basket token was worth, recorded as it happens.
--
-- The same argument as motif_levels and the same warning: a price that has
-- already gone cannot be re-read from the chain later, so every sweep that does
-- not happen is a permanent hole. It runs from the first day for that reason.
--
-- Two numbers per reading, because a basket token has two of them and the
-- second is the whole product:
--
--   price18  what one token costs. Before graduation that is the curve's own
--            price, which is arithmetic on `raised` and `sold` and needs no
--            chain read at all. After it, the token's own Uniswap pool.
--   floor18  what one token can be redeemed for, which is the vault's stock
--            divided by the supply. Null before graduation, because there is
--            no vault holding anything yet and a floor of zero would be a
--            different claim from "not yet".
--
-- Both are USDG per whole token in 1e18, and both are decimal strings, because
-- a double loses the low bits and these are chain amounts.
CREATE TABLE curve_levels (
  curve    TEXT NOT NULL,
  at       INTEGER NOT NULL,
  price18  TEXT NOT NULL,
  floor18  TEXT,
  PRIMARY KEY (curve, at)
);

CREATE INDEX curve_levels_recent ON curve_levels (curve, at DESC);
