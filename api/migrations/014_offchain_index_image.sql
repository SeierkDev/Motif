-- A picture for a motif, kept here rather than on chain.
--
-- The router deployed on this chain predates the image argument: its
-- createIndex has six parameters and no seventh for a picture, and a deployed
-- contract cannot grow one. Replacing it means a new address, a new factory
-- bound to it, and abandoning every motif already published, which is a large
-- price for a thumbnail.
--
-- It buys less than it looks like, too. The picture itself was never on chain:
-- `indexes.image` holds a url pointing back at this api's own /v1/images store,
-- so the bytes live on this disk either way. Putting the pointer in a log makes
-- the pointer immutable, not the picture, and a pointer to a server that is
-- gone is worth nothing.
--
-- So the association lives here, and `indexes.image` still wins when it is set,
-- which is what happens on any chain whose router is current. Separate table
-- rather than writing into `indexes.image`, because the indexer rebuilds that
-- row from the log and a reindex would erase every picture set this way.
CREATE TABLE index_images (
  index_id INTEGER PRIMARY KEY,
  image    TEXT    NOT NULL,
  -- Who signed for it, kept so a wrong one can be traced rather than guessed.
  setter   TEXT    NOT NULL,
  at       INTEGER NOT NULL
);
