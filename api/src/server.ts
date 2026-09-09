import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { isAddress, verifyMessage } from 'viem'
import { appliedMigrations, dbBytes, type DB } from './db.js'
import { config, factoryAddress, hasFactory, type Event, type Indexer } from './indexer.js'
import type { Keeper } from './keeper.js'
import type { Levels } from './levels.js'

const started = Date.now()

/**
 * What a creator signs to attach a picture to a motif they published.
 *
 * The router on this chain has no image argument and cannot grow one, so the
 * association is kept here instead. That makes the signature the only thing
 * standing between a motif and anybody else's picture, so it binds all three
 * facts that matter: which motif, which picture, and that it is this site
 * asking. Anything vaguer could be replayed from a signature collected
 * somewhere else.
 */
export function pictureMessage(indexId: number, image: string): string {
  return `Motif: set the picture for motif #${indexId}\n${image}`
}


/**
 * A rate gate, per address.
 *
 * The API is open and keyless on purpose, which is not the same as being free
 * to hammer. One caller looping the leaderboard should not be able to make the
 * indexer's own rpc budget somebody else's problem. Generous enough that no
 * honest integration will ever see it.
 */
const RATE_LIMIT = Number(process.env.MOTIF_RATE_LIMIT ?? 240)
const RATE_WINDOW_MS = 60_000
const hits = new Map<string, { n: number; resetAt: number }>()

function overRate(ip: string): { over: boolean; retryAfter: number } {
  const now = Date.now()
  const row = hits.get(ip)
  if (!row || now > row.resetAt) {
    hits.set(ip, { n: 1, resetAt: now + RATE_WINDOW_MS })
    // Sweep opportunistically rather than on a timer, so an idle process does
    // no work and the map cannot grow without bound.
    if (hits.size > 5_000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k)
    }
    return { over: false, retryAfter: 0 }
  }
  row.n++
  return { over: row.n > RATE_LIMIT, retryAfter: Math.ceil((row.resetAt - now) / 1000) }
}

/**
 * Open, keyless, wildcard CORS.
 *
 * Everything served here is already public on chain, so a key would only be
 * theatre. What it would actually do is stop somebody building against this
 * without asking permission first, which is the opposite of the point.
 */
function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': status === 200 ? 'public, max-age=5' : 'no-store',
  })
  res.end(json)
}

const num = (v: string | null, fallback: number, max: number) => {
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback
}

/**
 * Where a page of a feed stopped, as a position rather than as a block.
 *
 * @dev **A block is not a position.** `WHERE block < ?` skips whatever else was
 *      in the block the page ended on, and two buys in one block is ordinary.
 *      Measured rather than argued: the CI fixture holds three buys, two of them
 *      in one block, and paging it with `limit=1` returned two of the three. The
 *      missing one was not reachable by any cursor.
 *
 *      So the cursor is `block:logIndex`, and `log_index` is the index of the
 *      log within its block, which makes the pair unique and totally ordered.
 *      A bare number is still accepted and still means "before this block", so a
 *      client already holding an old cursor keeps working; it just cannot
 *      resolve a tie it was never given the information for.
 */
type Cursor = { block: number; logIndex: number | null }

function parseCursor(raw: string | null): Cursor | null {
  if (raw === null) return null
  const [b, l] = raw.split(':')
  const block = Number(b)
  if (!Number.isFinite(block)) return null
  const logIndex = l === undefined ? null : Number(l)
  return { block, logIndex: logIndex !== null && Number.isFinite(logIndex) ? logIndex : null }
}

/** The WHERE fragment and its arguments for everything strictly before `c`. */
function beforeClause(c: Cursor | null): { sql: string; args: number[] } {
  if (c === null) return { sql: '', args: [] }
  if (c.logIndex === null) return { sql: 'WHERE block < ?', args: [c.block] }
  return { sql: 'WHERE (block < ? OR (block = ? AND log_index < ?))', args: [c.block, c.block, c.logIndex] }
}

/** The cursor a client should send to continue, or null when the feed ran out. */
function nextCursor(rows: unknown[], limit: number): string | null {
  if (rows.length < limit) return null
  const last = rows[rows.length - 1] as { block: number; log_index: number } | undefined
  return last ? `${last.block}:${last.log_index}` : null
}


/* ------------------------------------------------------------------ images */

/**
 * Somewhere for a creator's picture to live, so that launching does not start
 * with going and finding hosting.
 *
 * **This is not authoritative and must never become so.** The record of what a
 * basket's picture is lives in the launch's own log on chain, and this endpoint
 * only holds bytes that a url can point at. Everything here is content
 * addressed: the id is the sha256 of the file, so the same picture uploaded
 * twice is one row, a url can be checked against its own content by anybody,
 * and nobody, this api included, can change the picture behind a url that has
 * already been recorded on chain. If the table is lost the launches are
 * unaffected and the files can be put back at the same urls by whoever still
 * has them.
 */
const MAX_IMAGE_BYTES = 512 * 1024

/** How many uploads one address may make a minute, which is a different question to reads. */
const UPLOAD_LIMIT = Number(process.env.MOTIF_UPLOAD_LIMIT ?? 12)

/**
 * How much the store may hold in total, and how long an unused file survives.
 *
 * @dev A rate limit alone does not bound a disk. Twelve uploads a minute of half
 *      a megabyte each is eight gigabytes a day from one address, and the api
 *      writes to a volume that the indexer's database is also on, so filling it
 *      takes the whole service down rather than just this endpoint. Two bounds:
 *      a hard ceiling on the total, and a sweep that deletes anything nothing
 *      points at.
 *
 *      **The sweep can only delete what no launch refers to.** A picture that
 *      has been through a launch is referenced from a log that cannot be
 *      edited, so it is kept forever. What it collects is the other case: files
 *      uploaded by somebody who then closed the tab, or by somebody filling the
 *      disk on purpose. A day is long enough that a launch interrupted by a
 *      wallet prompt and finished later still finds its picture there.
 */
const IMAGE_STORE_LIMIT = Number(process.env.MOTIF_IMAGE_STORE_LIMIT ?? 512 * 1024 * 1024)
const IMAGE_TTL_SECONDS = 24 * 60 * 60
const IMAGE_SWEEP_MS = 30 * 60_000

/**
 * Delete every image older than a day that no launch points at, and report how
 * much was reclaimed.
 *
 * @dev The match is on the tail of the url rather than on an id column, because
 *      what a launch records is a whole url and this api is not the only place
 *      one could point. A row here is only ever kept because some launch's url
 *      contains this hash.
 *
 *      **Contains, not ends with.** It was `LIKE '%' || hash`, which only
 *      matches a url whose last characters are the hash, and a creator is free
 *      to record `.../v1/images/<hash>?v=2` or the same url with a trailing
 *      slash. Either one was collected a day later and the link in a log that
 *      can never be edited 404s from then on, permanently. A hash is 64 hex
 *      characters and nothing collides with one by accident, so matching
 *      anywhere in the string costs nothing and closes that.
 */
export function sweepImages(db: DB): number {
  // **Nothing is collected while the factory is unset**, and that is the whole
  // difference between tidying up and deleting somebody's launch. The sweep
  // decides what is unreferenced by looking at `curves`, and `curves` is only
  // ever populated when MOTIF_FACTORY is configured, which it documented as
  // optional and currently is not. Without this the api would happily delete
  // every picture a day after it was uploaded, including the ones whose urls
  // are written into a log that can never be edited, and the 404 would be
  // permanent.
  if (!hasFactory()) return 0

  const cutoff = Math.floor(Date.now() / 1000) - IMAGE_TTL_SECONDS
  const doomed = db.all(
    `SELECT hash FROM images
      WHERE created_at < ?
        AND NOT EXISTS (SELECT 1 FROM curves WHERE curves.image LIKE '%' || images.hash || '%')`,
    [cutoff],
  ) as { hash: string }[]
  for (const row of doomed) db.run('DELETE FROM images WHERE hash = ?', [row.hash])
  return doomed.length
}

const storedBytes = (db: DB): number =>
  ((db.get('SELECT COALESCE(SUM(size), 0) AS n FROM images') as { n: number }).n ?? 0)
const uploads = new Map<string, { n: number; resetAt: number }>()

function overUploadRate(ip: string): boolean {
  const now = Date.now()
  const row = uploads.get(ip)
  if (!row || now > row.resetAt) {
    uploads.set(ip, { n: 1, resetAt: now + RATE_WINDOW_MS })
    if (uploads.size > 5_000) for (const [k, v] of uploads) if (now > v.resetAt) uploads.delete(k)
    return false
  }
  row.n++
  return row.n > UPLOAD_LIMIT
}

/**
 * What the bytes actually are, rather than what the request said they were.
 *
 * @dev A content type header is whatever the uploader typed. These four are the
 *      formats every browser renders, and anything that is not one of them is
 *      refused rather than stored and served back with a guess, because serving
 *      a file of unknown type from a domain the site runs on is how a picture
 *      host becomes a way to host something else.
 */
function sniffImage(b: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((v, k) => b[i + k] === v)
  if (b.length < 12) return null
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

/**
 * Where this api is reachable from, for handing back an absolute url.
 *
 * @dev Set MOTIF_PUBLIC_URL in front of a proxy that rewrites the host. The
 *      fallback reads the request, which is right in every ordinary case and
 *      wrong in exactly the case where somebody has already had to configure
 *      something else.
 */
function originOf(req: IncomingMessage): string {
  const configured = process.env.MOTIF_PUBLIC_URL?.trim().replace(/\/+$/, '')
  if (configured) return configured
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'http'
  return `${proto}://${req.headers.host ?? 'localhost'}`
}

/**
 * Read a request body, refusing anything over the cap rather than buffering it.
 *
 * @dev Null means over the cap or a broken connection, and the caller has to
 *      answer before hanging up: destroying the socket the moment the cap is
 *      passed leaves the uploader with a connection reset, which reads as the
 *      api being down rather than as a file being too big.
 */
function readBody(req: IncomingMessage, cap: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      if (over) return
      size += c.length
      if (size > cap) {
        // Nothing more is kept, and the rest is drained rather than stored, so
        // the response below can still reach the client.
        over = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => !over && resolve(new Uint8Array(Buffer.concat(chunks))))
    req.on('error', () => resolve(null))
  })
}

/**
 * The last `/v1/stats` answer, and when it was computed.
 *
 * @dev Held for as long as the route's own `cache-control` says, so a client
 *      that honours the header and one that does not see the same freshness.
 */
const STATS_TTL_MS = 5_000
let statsCache: { at: number; body: unknown } | null = null

export function createApi(db: DB, indexer: Indexer, keeper: Keeper, levels: Levels, port: number) {
  const sockets = new Set<WebSocket>()
  // Every motif row carries its own performance, so a caller never has to make
  // a second request per row to find out whether it went up.
  perf = (id: number) => levels.performance(id)

  const routes: [RegExp, (m: RegExpMatchArray, url: URL) => unknown][] = [
    [
      /^\/v1\/leaderboard$/,
      (_m, url) => {
        // Ranked by what actually happened, not by anything we curate. "volume"
        // is money through the basket, "fees" is what its creator has earned,
        // "new" is the launch feed.
        const by = url.searchParams.get('by') ?? 'volume'
        // Return is computed rather than stored, so it cannot be an ORDER BY.
        // Everything else sorts in SQL and this one sorts after the fact.
        const byReturn = by === 'return' || by === 'worst'
        const limit = num(url.searchParams.get('limit'), 50, 200)
        const order =
          by === 'fees'
            ? 'COALESCE(agg.fees_sort, 0) DESC'
            : by === 'buys'
              ? 'COALESCE(agg.buys, 0) DESC'
              : by === 'new'
                ? 'i.ts DESC, i.id DESC'
                : 'COALESCE(agg.volume_sort, 0) DESC'
        const rows = db.all(
          `SELECT i.*,
                  COALESCE(agg.buys, 0)    AS buys,
                  agg.volume_parts         AS volume_parts,
                  agg.volume_sort          AS volume_sort,
                  agg.fees_parts           AS fees_parts,
                  agg.fees_sort            AS fees_sort,
                  COALESCE(agg.holders, 0) AS holders,
                  agg.last_buy_ts          AS lastBuyTs
             FROM indexes i
             LEFT JOIN (
               SELECT index_id,
                      COUNT(*)                          AS buys,
                      GROUP_CONCAT(amount_in)           AS volume_parts,
                      GROUP_CONCAT(creator_fee)         AS fees_parts,
                      SUM(CAST(amount_in AS REAL))      AS volume_sort,
                      SUM(CAST(creator_fee AS REAL))    AS fees_sort,
                      COUNT(DISTINCT buyer)             AS holders,
                      MAX(ts)                           AS last_buy_ts
                 FROM buys GROUP BY index_id
             ) agg ON agg.index_id = i.id
            ORDER BY ${order}
            LIMIT ?`,
          [byReturn ? 500 : limit],
        )
        let out = rows.map((r) => withLegs(db, r))
        if (byReturn) {
          const key = (m: { performance: Perf | null }) => m.performance?.changeBps?.inception ?? null
          out = out
            // A motif with no reading yet is not "flat", it is unknown, so it
            // sits out of the ranking rather than landing in the middle of it.
            .filter((m) => key(m) !== null)
            .sort((a, b) => (by === 'worst' ? key(a)! - key(b)! : key(b)! - key(a)!))
            .slice(0, limit)
        }
        return { by, indexes: out }
      },
    ],
    [
      /^\/v1\/trending$/,
      (_m, url) => {
        // Activity inside a window rather than all time, so something launched
        // this morning can outrank something from last month.
        const hours = num(url.searchParams.get('hours'), 24, 720)
        const since = Math.floor(Date.now() / 1000) - hours * 3600
        const rows = db.all(
          `SELECT i.*, COUNT(b.tx) AS buys, GROUP_CONCAT(b.amount_in) AS volume_parts,
                  SUM(CAST(b.amount_in AS REAL)) AS volume_sort
             FROM indexes i JOIN buys b ON b.index_id = i.id
            WHERE b.ts >= ?
            GROUP BY i.id ORDER BY volume_sort DESC LIMIT ?`,
          [since, num(url.searchParams.get('limit'), 25, 100)],
        )
        return { hours, indexes: rows.map((r) => withLegs(db, r)) }
      },
    ],
    [
      /^\/v1\/creators$/,
      (_m, url) => ({
        creators: db.all(
          `SELECT i.creator,
                  COUNT(DISTINCT i.id)              AS launched,
                  GROUP_CONCAT(agg.fees_parts)      AS fees_parts,
                  GROUP_CONCAT(agg.volume_parts)    AS volume_parts,
                  MAX(i.ts)                         AS lastLaunchTs
             FROM indexes i
             LEFT JOIN (
               SELECT index_id,
                      GROUP_CONCAT(creator_fee) AS fees_parts,
                      GROUP_CONCAT(amount_in)   AS volume_parts,
                      SUM(CAST(creator_fee AS REAL)) AS fees_sort
                 FROM buys GROUP BY index_id
             ) agg ON agg.index_id = i.id
            GROUP BY i.creator ORDER BY SUM(agg.fees_sort) DESC LIMIT ?`,
          [num(url.searchParams.get('limit'), 50, 200)],
        ).map((c) => {
          const { volume_parts, fees_parts, volume_sort, fees_sort, ...rest } = c as Record<string, unknown>
          return { ...rest, volume: sumText([volume_parts as string]), fees: sumText([fees_parts as string]) }
        }),
      }),
    ],
    [
      /^\/v1\/creators\/(0x[0-9a-fA-F]{40})$/,
      (m) => {
        const who = m[1]!.toLowerCase()
        const rows = db.all(
          `SELECT i.*, COALESCE(agg.buys, 0) AS buys,
                  agg.volume_parts AS volume_parts,
                  agg.fees_parts   AS fees_parts
             FROM indexes i
             LEFT JOIN (
               SELECT index_id, COUNT(*) AS buys,
                      GROUP_CONCAT(amount_in) AS volume_parts,
                      GROUP_CONCAT(creator_fee) AS fees_parts
                 FROM buys GROUP BY index_id
             ) agg ON agg.index_id = i.id
            WHERE i.creator = ? ORDER BY i.id DESC`,
          [who],
        )
        const indexes = rows.map((r) => withLegs(db, r))
        const feesEarned = sumText(indexes.map((i) => i.fees))
        return { address: who, launched: rows.length, feesEarned, indexes }
      },
    ],
    [
      /^\/v1\/indexes$/,
      (_m, url) => {
        const limit = num(url.searchParams.get('limit'), 50, 200)
        const rows = db.all(
          `SELECT i.*, (SELECT COUNT(*) FROM buys b WHERE b.index_id = i.id) AS buys
             FROM indexes i ORDER BY i.id DESC LIMIT ?`,
          [limit],
        )
        return { indexes: rows.map((r) => withLegs(db, r)) }
      },
    ],
    [
      /^\/v1\/indexes\/(\d+)$/,
      (m) => {
        const row = db.get(
          `SELECT i.*,
                  COALESCE(agg.buys, 0)    AS buys,
                  agg.volume_parts         AS volume_parts,
                  agg.fees_parts           AS fees_parts,
                  COALESCE(agg.holders, 0) AS holders
             FROM indexes i
             LEFT JOIN (
               SELECT index_id, COUNT(*) AS buys,
                      GROUP_CONCAT(amount_in)   AS volume_parts,
                      GROUP_CONCAT(creator_fee) AS fees_parts,
                      COUNT(DISTINCT buyer)          AS holders
                 FROM buys GROUP BY index_id
             ) agg ON agg.index_id = i.id
            WHERE i.id = ?`,
          [Number(m[1])],
        )
        if (!row) return null
        return withLegs(db, row)
      },
    ],
    [
      /^\/v1\/indexes\/(\d+)\/history$/,
      (m, url) => ({
        levels: levels.history(Number(m[1]), num(url.searchParams.get('limit'), 500, 2000)),
        performance: levels.performance(Number(m[1])),
      }),
    ],
    [
      /^\/v1\/indexes\/(\d+)\/buys$/,
      (m, url) => ({
        buys: db.all('SELECT * FROM buys WHERE index_id = ? ORDER BY block DESC LIMIT ?', [
          Number(m[1]),
          num(url.searchParams.get('limit'), 50, 500),
        ]),
      }),
    ],
    [
      /^\/v1\/buys$/,
      (_m, url) => {
        // Keyset paging, not an offset. An offset silently skips or repeats
        // rows when new buys land between two pages, which on a live feed is
        // most of the time. The key is (block, log_index): a block on its own
        // is not a position, and paging past one loses whatever else was in it.
        const limit = num(url.searchParams.get('limit'), 50, 500)
        const c = beforeClause(parseCursor(url.searchParams.get('before')))
        const rows = db.all(
          `SELECT * FROM buys ${c.sql} ORDER BY block DESC, log_index DESC LIMIT ?`,
          [...c.args, limit],
        )
        return { buys: rows, next: nextCursor(rows, limit) }
      },
    ],
    [
      /^\/v1\/indexes\/(\d+)\/sells$/,
      (m, url) => ({
        sells: db.all('SELECT * FROM sells WHERE index_id = ? ORDER BY block DESC LIMIT ?', [
          Number(m[1]),
          num(url.searchParams.get('limit'), 50, 500),
        ]),
      }),
    ],
    [
      /^\/v1\/sells$/,
      (_m, url) => {
        // The same key as `/v1/buys`, and for the same reason.
        const limit = num(url.searchParams.get('limit'), 50, 500)
        const c = beforeClause(parseCursor(url.searchParams.get('before')))
        const rows = db.all(
          `SELECT * FROM sells ${c.sql} ORDER BY block DESC, log_index DESC LIMIT ?`,
          [...c.args, limit],
        )
        return { sells: rows, next: nextCursor(rows, limit) }
      },
    ],
    [
      /^\/v1\/holders\/(0x[0-9a-fA-F]{40})$/,
      (m) => {
        const who = m[1]!.toLowerCase()
        return {
          address: who,
          buys: db.all('SELECT * FROM buys WHERE buyer = ? ORDER BY block DESC LIMIT 200', [who]),
          sells: db.all('SELECT * FROM sells WHERE seller = ? ORDER BY block DESC LIMIT 200', [who]),
          rebalances: db.all(
            'SELECT * FROM rebalances WHERE holder = ? ORDER BY block DESC LIMIT 200',
            [who],
          ),
        }
      },
    ],
    [
      /^\/v1\/rebalances$/,
      (_m, url) => ({
        rebalances: db.all('SELECT * FROM rebalances ORDER BY block DESC LIMIT ?', [
          num(url.searchParams.get('limit'), 50, 500),
        ]),
      }),
    ],
    [
      /^\/v1\/orders$/,
      (_m, url) => {
        const owner = url.searchParams.get('owner')
        const rows = owner
          ? db.all('SELECT * FROM orders WHERE owner = ? ORDER BY id DESC LIMIT 200', [
              owner.toLowerCase(),
            ])
          : db.all('SELECT * FROM orders WHERE active = 1 ORDER BY id DESC LIMIT 200')
        return { orders: rows }
      },
    ],
    [
      /^\/v1\/stats$/,
      () => {
        /*
         * Memoised for the five seconds this route already tells clients to
         * cache it for.
         *
         * The three money totals are `SUM` done in BigInt, which means reading
         * every amount out of `buys`, `sells` and `curves` on every request.
         * That is right and it is not negotiable: SQLite's own SUM goes through
         * a double and loses the low bits above 2^53. What is negotiable is
         * doing it once per visitor per poll. `/how` polls this, so at a
         * hundred readers it was a hundred full scans of the activity tables
         * every few seconds to produce a number that is identical every time.
         */
        const now = Date.now()
        if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.body

        const one = (q: string) => (db.get(q) as { n: number } | undefined)?.n ?? 0
        const body = {
          indexes: one('SELECT COUNT(*) AS n FROM indexes'),
          buys: one('SELECT COUNT(*) AS n FROM buys'),
          sells: one('SELECT COUNT(*) AS n FROM sells'),
          rebalances: one('SELECT COUNT(*) AS n FROM rebalances'),
          uniqueBuyers: one('SELECT COUNT(DISTINCT buyer) AS n FROM buys'),
          // Creators of either kind. A basket token publishes its index from
          // inside the curve, so `indexes.creator` for one of those is the
          // curve's own address rather than a person, and counting only that
          // column credited a contract and missed the human who launched it.
          creators: one(
            `SELECT COUNT(*) AS n FROM (
               SELECT creator FROM indexes
               UNION SELECT creator FROM curves)`,
          ),
          // The tokenised half, which this route did not know existed.
          curves: one('SELECT COUNT(*) AS n FROM curves'),
          graduated: one('SELECT COUNT(*) AS n FROM curves WHERE graduated = 1'),
          raisedOnCurves: sumText(
            (db.all('SELECT raised FROM curves') as { raised: string }[]).map((r) => r.raised),
          ),
          volumeIn: sumText(
            (db.all('SELECT amount_in FROM buys') as { amount_in: string }[]).map((r) => r.amount_in),
          ),
          // Reported separately rather than netted off. Money in and money out
          // are two facts, and a single "net volume" hides which one moved.
          volumeOut: sumText(
            (db.all('SELECT amount_out FROM sells') as { amount_out: string }[]).map(
              (r) => r.amount_out,
            ),
          ),
        }
        statsCache = { at: now, body }
        return body
      },
    ],
    [
      /^\/v1\/status$/,
      () => ({
        // Both halves have to be alive. An indexer that is current while the
        // keeper has given up means orders are quietly not firing. A rejected
        // key counts the same way: the service was configured to keep and is
        // not keeping, which is exactly the state this must never call ok.
        ok:
          indexer.lastError === null &&
          indexer.configError === null &&
          keeper.keyError === null &&
          (!keeper.enabled || keeper.stopped === null),
        // Named honestly: an indexer that has stalled is not healthy just
        // because the http server still answers.
        indexer: {
          lastBlock: indexer.cursor,
          lastRunAt: indexer.lastRunAt || null,
          secondsSinceRun: indexer.lastRunAt ? Math.round((Date.now() - indexer.lastRunAt) / 1000) : null,
          error: indexer.lastError,
          // Separated from `error` on purpose: a variable holding a placeholder
          // is not a chain that is briefly unreachable, and retrying will never
          // fix it. configWarning is the value that was wrong and ignored.
          configError: indexer.configError,
          configWarning: indexer.configWarning,
        },
        keeper: keeper.status(),
        levels: levels.status(),
        chain: {
          rpc: config.RPC,
          router: config.ROUTER,
          rebalancer: config.REBALANCER,
          orders: config.ORDERS,
          // Optional, and its absence is a fact rather than a fault: without it
          // there are no basket tokens to index and /v1/curves is empty, which
          // otherwise looks like an indexer that is quietly broken.
          //
          // This is the address being indexed rather than the variable that was
          // set, so a typo reads as null here and says what it was under
          // configWarning. Echoing the raw variable claimed a factory was
          // configured while nothing was being scanned for launches at all.
          factory: factoryAddress(),
        },
        migrations: appliedMigrations(db),
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        subscribers: sockets.size,
        /**
         * What the data occupies, which is not what the volume graph shows.
         *
         * `images` is the picture store's share, since that is the one part
         * bounded by a variable rather than by usage, and knowing whether the
         * database is mostly rows or mostly blobs decides which lever to pull.
         */
        storage: {
          ...dbBytes(),
          images: Number(
            (db.get('SELECT COALESCE(SUM(size), 0) AS n FROM images') as { n: number } | undefined)?.n ?? 0,
          ),
        },
      }),
    ],
    /**
     * Every basket token, newest first.
     *
     * @remarks `progressBps` is served rather than a percentage, and `raised`
     * and `threshold` are decimal strings, because they are usdg amounts and
     * money never goes through a float in this codebase. `stateAt` is the age
     * of the moving half: null means it has never been read, which a client
     * must render as unknown rather than as zero.
     */
    [
      /^\/v1\/curves$/,
      (_m, url) => {
        const limit = num(url.searchParams.get('limit'), 60, 200)
        const rows = db.all(
          `SELECT curve, index_id, creator, vault, pool, threshold, creator_fee_bps, leg_count,
                  name, symbol, description, image, block, tx, ts,
                  raised, sold, supply, graduated, state_at
             FROM curves ORDER BY block DESC, curve DESC LIMIT ?`,
          [limit],
        ) as Record<string, unknown>[]

        // Joined here rather than left to the client. A tile is drawn from the
        // weights, so without them the grid is either N+1 requests deep or a
        // wall of grey placeholders, which is the thing this project refuses to
        // ship. One query for all of them.
        const legsByIndex = new Map<
          number,
          { position: number; token: string; fee: number; weight_bps: number }[]
        >()
        if (rows.length > 0) {
          const ids = [...new Set(rows.map((r) => Number(r.index_id)))]
          const legRows = db.all(
            `SELECT index_id, position, token, fee, weight_bps FROM legs
              WHERE index_id IN (${ids.map(() => '?').join(',')})
              ORDER BY index_id, position`,
            ids,
          ) as { index_id: number; position: number; token: string; fee: number; weight_bps: number }[]
          for (const l of legRows) {
            const list = legsByIndex.get(l.index_id) ?? []
            list.push({ position: l.position, token: l.token, fee: l.fee, weight_bps: l.weight_bps })
            legsByIndex.set(l.index_id, list)
          }
        }

        return {
          curves: rows.map((r) => {
            const raised = BigInt((r.raised as string) || '0')
            const threshold = BigInt((r.threshold as string) || '0')
            return {
              curve: r.curve,
              indexId: r.index_id,
              creator: r.creator,
              vault: r.vault,
              pool: r.pool,
              name: r.name,
              symbol: r.symbol,
              description: r.description,
              // The url the launch put in its log, and empty when there was
              // none. A client renders the basket's own weights in that case,
              // which is what every motif tile on this site already does.
              image: r.image || null,
              legCount: r.leg_count,
              legs: legsByIndex.get(Number(r.index_id)) ?? [],
              creatorFeeBps: r.creator_fee_bps,
              threshold: String(threshold),
              raised: String(raised),
              sold: r.sold,
              supply: r.supply,
              graduated: (r.graduated as number) === 1,
              // Integer basis points, so no float rounds 99.99% up to done.
              progressBps: threshold === 0n ? 0 : Number((raised * 10_000n) / threshold),
              block: r.block,
              tx: r.tx,
              ts: r.ts,
              stateAt: r.state_at ?? null,
            }
          }),
        }
      },
    ],
    /**
     * One basket token, by its curve address.
     *
     * @remarks The token page reads everything else it needs off the chain, so
     * this exists for the one thing that is only in a log: the creator's own
     * picture. A page that cannot reach this still works and draws the basket's
     * weights instead, which is why the answer here is never load bearing.
     */
    [
      /^\/v1\/curves\/(0x[0-9a-fA-F]{40})$/,
      (m) => {
        const row = db.get(
          `SELECT curve, index_id, creator, vault, pool, threshold, creator_fee_bps, leg_count,
                  name, symbol, description, image, block, tx, ts,
                  raised, sold, supply, graduated, state_at
             FROM curves WHERE curve = ?`,
          [m[1]!.toLowerCase()],
        ) as Record<string, unknown> | undefined
        if (!row) return null

        const legs = db.all(
          `SELECT position, token, fee, weight_bps FROM legs WHERE index_id = ? ORDER BY position`,
          [Number(row.index_id)],
        )
        const raised = BigInt((row.raised as string) || '0')
        const threshold = BigInt((row.threshold as string) || '0')
        return {
          curve: {
            curve: row.curve,
            indexId: row.index_id,
            creator: row.creator,
            vault: row.vault,
            pool: row.pool,
            name: row.name,
            symbol: row.symbol,
            description: row.description,
            image: row.image || null,
            legCount: row.leg_count,
            legs,
            creatorFeeBps: row.creator_fee_bps,
            threshold: String(threshold),
            raised: String(raised),
            sold: row.sold,
            supply: row.supply,
            graduated: (row.graduated as number) === 1,
            progressBps: threshold === 0n ? 0 : Number((raised * 10_000n) / threshold),
            block: row.block,
            tx: row.tx,
            ts: row.ts,
            stateAt: row.state_at ?? null,
          },
        }
      },
    ],
    /**
     * Price and floor over time for one basket token.
     *
     * @remarks Both are USDG per whole token as decimal strings, 1e18. `floor`
     * is null for every reading taken before graduation, because there was no
     * vault holding anything yet, and a client has to draw that as absent
     * rather than as zero: they are different claims.
     */
    [
      /^\/v1\/curves\/(0x[0-9a-fA-F]{40})\/history$/,
      (m, url) => ({
        levels: levels.curveHistory(m[1]!, num(url.searchParams.get('limit'), 500, 2000)),
      }),
    ],
    [/^\/healthz$/, () => ({ ok: true })],
    /**
     * The root, answering 200 rather than the route list with a 404.
     *
     * A platform healthcheck is one path in a settings box, and the two
     * services here wanted opposite ones: this served /healthz and 404d on /,
     * the site served / and 404d on /healthz. Both were pointed the wrong way
     * round, one after the other, and each mistake reads the same from the
     * outside: the container starts, logs that it is listening, and is then
     * failed after five minutes of retries with no deployment ever going live,
     * which presents as the platform saying the domain does not exist.
     *
     * So both services now answer both paths and the setting cannot be wrong.
     */
    [/^\/$/, () => ({ ok: true, service: 'motif api', docs: '/v1/status' })],
  ]

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': '*',
      })
      return res.end()
    }

    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown'
    const gate = overRate(ip)
    if (gate.over) {
      res.setHeader('retry-after', String(gate.retryAfter))
      return send(res, 429, {
        error: `rate limit, ${RATE_LIMIT} requests a minute`,
        retryAfter: gate.retryAfter,
      })
    }

    const url = new URL(req.url ?? '/', 'http://localhost')

    // The one thing here that is written to rather than read from, and the only
    // route that is not a GET. It is kept out of the table below because that
    // table is a map of pathname to a plain object, and neither half of that
    // fits: this one has a body coming in and bytes going out.
    /*
     * Attach a picture to a motif, proved by the creator's own signature.
     *
     * Open and keyless like the rest of this api, so the signature is the whole
     * of the authorisation: the message names the motif and the picture, and
     * the address it recovers to has to be the creator this api indexed from
     * the chain. Nobody can set a picture on somebody else's motif without
     * their key, and no picture can be moved to a different motif, because the
     * id is inside the signed text.
     */
    const imageSetMatch = /^\/v1\/indexes\/(\d+)\/image$/.exec(url.pathname)
    if (imageSetMatch !== null && req.method === 'POST') {
      const indexId = Number(imageSetMatch[1])
      if (overUploadRate(ip)) {
        return send(res, 429, { error: `upload limit, ${UPLOAD_LIMIT} a minute` })
      }
      return void readBody(req, 4096)
        .then(async (body) => {
          if (body === null) return send(res, 413, { error: 'body too large' })
          let parsed: { image?: unknown; signature?: unknown }
          try {
            parsed = JSON.parse(new TextDecoder().decode(body)) as { image?: unknown; signature?: unknown }
          } catch {
            return send(res, 400, { error: 'expected JSON: { image, signature }' })
          }
          const image = typeof parsed.image === 'string' ? parsed.image.trim() : ''
          const signature = typeof parsed.signature === 'string' ? parsed.signature.trim() : ''
          if (image === '' || signature === '') {
            return send(res, 400, { error: 'expected JSON: { image, signature }' })
          }
          // Bounded for the same reason the contract bounds it: this string is
          // served to every visitor who loads the grid.
          if (image.length > 400) return send(res, 400, { error: 'image url over 400 bytes' })
          if (!/^https?:\/\//i.test(image)) {
            return send(res, 400, { error: 'image has to be an http or https url' })
          }

          const row = db.get('SELECT creator FROM indexes WHERE id = ?', [indexId]) as
            | { creator: string }
            | undefined
          if (!row) return send(res, 404, { error: `no motif #${indexId}` })
          if (!isAddress(row.creator)) return send(res, 500, { error: 'indexed creator is not an address' })

          let ok = false
          try {
            ok = await verifyMessage({
              address: row.creator as `0x${string}`,
              message: pictureMessage(indexId, image),
              signature: signature as `0x${string}`,
            })
          } catch {
            ok = false
          }
          if (!ok) {
            return send(res, 403, {
              error: `that signature is not from ${row.creator}, who published motif #${indexId}`,
            })
          }

          db.run(
            `INSERT INTO index_images (index_id, image, setter, at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(index_id) DO UPDATE SET image = excluded.image, setter = excluded.setter, at = excluded.at`,
            [indexId, image, row.creator.toLowerCase(), Math.floor(Date.now() / 1000)],
          )
          send(res, 200, { indexId, image })
        })
        .catch(() => send(res, 400, { error: 'could not read the body' }))
    }

    if (url.pathname === '/v1/images' && req.method === 'POST') {
      if (overUploadRate(ip)) {
        return send(res, 429, { error: `upload limit, ${UPLOAD_LIMIT} a minute` })
      }
      const tooBig = { error: `an image has to be 1 to ${MAX_IMAGE_BYTES} bytes` }
      // Answered from the header when there is one, so an oversized upload is
      // refused before it is sent rather than after.
      if (Number(req.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES) {
        return send(res, 413, tooBig)
      }
      return void readBody(req, MAX_IMAGE_BYTES)
        .then((body) => {
          if (body === null || body.length === 0) return send(res, 413, tooBig)
          const mime = sniffImage(body)
          if (mime === null) {
            return send(res, 415, { error: 'png, jpeg, gif or webp only, read from the file itself' })
          }
          const hash = createHash('sha256').update(body).digest('hex')

          // Checked after the sweep rather than before it, so a store that is
          // full of files nobody kept empties itself instead of refusing
          // everybody. Skipped entirely when this file is already stored, since
          // storing it again costs nothing.
          const known = db.get('SELECT 1 AS n FROM images WHERE hash = ?', [hash]) as
            | { n: number }
            | undefined
          if (!known) {
            if (storedBytes(db) + body.length > IMAGE_STORE_LIMIT) {
              sweepImages(db)
              if (storedBytes(db) + body.length > IMAGE_STORE_LIMIT) {
                return send(res, 507, {
                  error: 'the image store is full. Host the file yourself and pass its url.',
                })
              }
            }
          }

          db.run(
            `INSERT OR IGNORE INTO images (hash, mime, bytes, size, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [hash, mime, body, body.length, Math.floor(Date.now() / 1000)],
          )
          const path = `/v1/images/${hash}`
          send(res, 200, { hash, path, url: `${originOf(req)}${path}`, mime, size: body.length })
        })
        // The route table below is wrapped in try/catch and answers 500. This
        // one is a promise, so a throw inside it went nowhere: the client was
        // left holding an open request until it timed out, and node logged an
        // unhandled rejection. Same answer as every other route.
        .catch((e) => send(res, 500, { error: (e as Error).message }))
    }

    const image = url.pathname.match(/^\/v1\/images\/([0-9a-f]{64})$/)
    if (image && req.method === 'GET') {
      const row = db.get('SELECT mime, bytes FROM images WHERE hash = ?', [image[1]!]) as
        | { mime: string; bytes: Uint8Array }
        | undefined
      if (!row) return send(res, 404, { error: 'not found' })
      res.writeHead(200, {
        'content-type': row.mime,
        'content-length': String(row.bytes.length),
        'access-control-allow-origin': '*',
        // The url is the hash of the bytes, so it can never answer with
        // anything else and immutable is a statement of fact rather than a bet.
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline',
      })
      return void res.end(Buffer.from(row.bytes))
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'GET only, except POST /v1/images' })
    for (const [pattern, handler] of routes) {
      const m = url.pathname.match(pattern)
      if (!m) continue
      try {
        const body = handler(m, url)
        return body === null
          ? send(res, 404, { error: 'not found' })
          : send(res, 200, body)
      } catch (e) {
        return send(res, 500, { error: (e as Error).message })
      }
    }
    send(res, 404, {
      error: 'not found',
      routes: [
        'GET /v1/leaderboard?by=volume|fees|buys|new|return|worst',
        'GET /v1/trending?hours=24',
        'GET /v1/creators',
        'GET /v1/creators/:address',
        'GET /v1/indexes',
        'GET /v1/indexes/:id',
        'GET /v1/indexes/:id/buys',
        'GET /v1/buys',
        'GET /v1/sells',
        'GET /v1/indexes/:id/sells',
        'GET /v1/rebalances',
        'GET /v1/holders/:address',
        'GET /v1/stats',
        'GET /v1/status',
        'GET /v1/images/:sha256',
        'POST /v1/images',
        'GET /v1/orders',
        'GET /v1/indexes/:id/history',
        'GET /v1/curves',
        'GET /v1/curves/:curve',
        'GET /v1/curves/:curve/history',
        'WS  /v1/stream',
      ],
    })
  })

  const wss = new WebSocketServer({ server, path: '/v1/stream' })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    ws.send(JSON.stringify({ kind: 'hello', lastBlock: indexer.cursor }))
    // A dead client that never sends a close frame otherwise sits in the set
    // forever and the subscriber count becomes a lie.
    const ping = setInterval(() => ws.ping(), 30_000)
    ws.on('close', () => {
      clearInterval(ping)
      sockets.delete(ws)
    })
    ws.on('error', () => {
      clearInterval(ping)
      sockets.delete(ws)
    })
  })

  const broadcast = (e: Event) => {
    const msg = JSON.stringify(e)
    for (const ws of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(msg)
    }
  }

  // Unreferenced pictures do not collect themselves. Unref'd so an otherwise
  // idle process still exits on its own.
  const sweeper = setInterval(() => {
    try {
      const gone = sweepImages(db)
      if (gone > 0) console.log(`[images] swept ${gone} unused`)
    } catch (e) {
      console.warn(`[images] sweep failed: ${(e as Error).message}`)
    }
  }, IMAGE_SWEEP_MS)
  sweeper.unref?.()

  server.listen(port, () => console.log(`[api] listening on ${port}`))
  return { server, broadcast, subscribers: () => sockets.size }
}

/**
 * Sum a list of integer strings exactly.
 *
 * SQLite has no integer type wider than 64 bits and its REAL is a double, so
 * `SUM(CAST(x AS REAL))` quietly loses the low bits above 2^53. That is
 * harmless for USDG at 6 decimals until about nine billion dollars, and wrong
 * immediately for an 18 decimal quote asset, which the allowlist now permits.
 * Returned as a string so it survives JSON as well.
 */
function sumText(parts: (string | null | undefined)[]): string {
  let total = 0n
  for (const p of parts) {
    if (!p) continue
    for (const one of String(p).split(',')) {
      if (one) total += BigInt(one)
    }
  }
  return total.toString()
}

type Perf = { level: string | null; since: number | null; changeBps: Record<string, number | null> }
let perf: ((id: number) => Perf) | null = null

function withLegs(db: DB, row: Record<string, unknown>) {
  const { volume_parts, fees_parts, volume_sort, fees_sort, ...rest } = row as Record<string, unknown>

  /*
   * The log wins, and this fills in when there is nothing in it.
   *
   * A chain whose router records pictures puts one in `indexes.image` and this
   * never runs. This one's router predates that argument, so the column is
   * always empty and the picture comes from `index_images` instead. Written in
   * that order deliberately: when the router is eventually replaced, the on
   * chain value takes over on its own with nothing here to change.
   */
  const image =
    (rest.image as string) ||
    (
      db.get('SELECT image FROM index_images WHERE index_id = ?', [row.id as number]) as
        | { image: string }
        | undefined
    )?.image ||
    ''

  return {
    ...rest,
    image,
    volume: sumText([volume_parts as string]),
    fees: sumText([fees_parts as string]),
    performance: perf ? perf(row.id as number) : null,
    legs: db.all('SELECT position, token, fee, weight_bps FROM legs WHERE index_id = ? ORDER BY position', [
      row.id as number,
    ]),
  }
}
