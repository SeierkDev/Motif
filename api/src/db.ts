import pkg from 'node-sqlite3-wasm'
import { readdirSync, readFileSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { Database } = pkg
type DB = InstanceType<typeof Database>

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', 'migrations')

/** Where `open` put the database, so its size can be reported. */
let dbFile = ''

/**
 * What the database actually occupies on disk.
 *
 * @remarks Reported on `/v1/status` because the platform's volume graph
 *          answers a different question. A volume reserves 2 to 3% of its
 *          total for filesystem metadata, and that shows as used, so resizing
 *          a volume to 100GB puts gigabytes on the graph before a single row
 *          is written. Watching that number to judge whether the data is
 *          growing is watching the wrong one, and the difference between the
 *          two is the whole answer.
 *
 *          The WAL is counted separately rather than folded in. It grows
 *          between checkpoints and shrinks again, so a large `wal` with a
 *          small `main` is a checkpoint that has not happened yet rather than
 *          data, and reporting only the total would make that look permanent.
 */
export function dbBytes(): { total: number; main: number; wal: number } {
  const size = (p: string): number => {
    try {
      return statSync(p).size
    } catch {
      // Absent rather than unreadable: there is no WAL until the first write.
      return 0
    }
  }
  if (dbFile === '') return { total: 0, main: 0, wal: 0 }
  const main = size(dbFile)
  const wal = size(`${dbFile}-wal`) + size(`${dbFile}-shm`)
  return { total: main + wal, main, wal }
}

/**
 * SQLite compiled to WebAssembly rather than the native binding.
 *
 * The native one needs a C toolchain, which turns "clone and run it" into
 * "install Visual Studio first" on Windows. This has no build step at all and
 * the file it writes is an ordinary SQLite database, so anything can read it.
 */
export function open(path: string): DB {
  mkdirSync(dirname(path), { recursive: true })
  dbFile = path
  const db = new Database(path)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

/**
 * Apply every migration that has not run yet, in filename order, each inside a
 * transaction.
 *
 * Numbered files rather than a checksum of the schema, so a migration that has
 * already run is never rewritten. Editing an applied migration is how a
 * database ends up in a state no version of the code expects.
 */
export function migrate(db: DB): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)

  const done = new Set(
    (db.all('SELECT name FROM schema_migrations') as { name: string }[]).map((r) => r.name),
  )
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    if (done.has(file)) continue
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    db.run('BEGIN')
    try {
      // node-sqlite3-wasm runs one statement per call, so split on the
      // semicolons that end a statement and skip whatever is left over.
      for (const stmt of sql.split(/;\s*$/m)) {
        const trimmed = stmt.trim()
        if (trimmed) db.run(trimmed)
      }
      db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [file, Date.now()])
      db.run('COMMIT')
      console.log(`[db] applied ${file}`)
    } catch (e) {
      db.run('ROLLBACK')
      throw new Error(`migration ${file} failed: ${(e as Error).message}`)
    }
  }
}

export function appliedMigrations(db: DB): string[] {
  return (db.all('SELECT name FROM schema_migrations ORDER BY name') as { name: string }[]).map(
    (r) => r.name,
  )
}

export type { DB }
