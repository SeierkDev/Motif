-- A keeper needs a work list. Without these it would have to walk every order
-- id from zero on every pass, and it would have no way at all to discover who
-- has a live subscription.
CREATE TABLE orders (
  id        INTEGER PRIMARY KEY,
  owner     TEXT NOT NULL,
  token     TEXT NOT NULL,
  kind      INTEGER NOT NULL,
  amount    TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_open ON orders (active, id);
CREATE INDEX orders_by_owner ON orders (owner, id DESC);

CREATE TABLE subscriptions (
  holder    TEXT PRIMARY KEY,
  index_id  INTEGER NOT NULL,
  drift_bps INTEGER NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX subs_open ON subscriptions (active);

-- What the keeper actually did, so a stall is visible rather than silent.
CREATE TABLE keeper_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  target    TEXT NOT NULL,
  tx        TEXT,
  ok        INTEGER NOT NULL,
  detail    TEXT
);
CREATE INDEX keeper_log_recent ON keeper_log (at DESC);
