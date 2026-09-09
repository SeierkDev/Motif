-- A basket stops being an integer. Name, symbol and description arrive in the
-- IndexCreated event rather than storage, so they are only ever available here.
ALTER TABLE indexes ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE indexes ADD COLUMN symbol TEXT NOT NULL DEFAULT '';
ALTER TABLE indexes ADD COLUMN description TEXT NOT NULL DEFAULT '';

CREATE INDEX indexes_by_symbol ON indexes (symbol);
