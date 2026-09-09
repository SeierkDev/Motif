-- A creator's own picture for their basket token.
--
-- Two halves, and the split is the point.
--
-- `curves.image` is the url the launch put in its log. That is the record: the
-- chain says what the picture is, this table only remembers what the chain
-- said, and re-indexing from block zero reproduces it exactly. There is no way
-- for anybody, including whoever runs this api, to change the picture on a
-- basket they did not launch.
--
-- `images` is somewhere for the bytes to live, so that a creator does not have
-- to go and find hosting before they can launch. It is content addressed: the
-- id is the sha256 of the bytes, so the same picture uploaded twice is one row,
-- and a url that points here can be checked against its own content by anybody.
-- That is what stops this table being authoritative about anything. If it is
-- lost, the launch is unaffected and the picture can be re-uploaded to the same
-- url by whoever still has the file.
ALTER TABLE curves ADD COLUMN image TEXT NOT NULL DEFAULT '';

CREATE TABLE images (
  -- Lower case hex sha256 of `bytes`, 64 characters.
  hash       TEXT PRIMARY KEY,
  -- Sniffed from the bytes rather than trusted from the request header, because
  -- a header is whatever the uploader typed.
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
