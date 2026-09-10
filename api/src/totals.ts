import type { DB } from './db.js'

/**
 * Running totals for the routes that used to add up every buy on every request.
 *
 * @dev The leaderboard, both creator routes, a motif's own page and `/v1/stats`
 *      each aggregated the whole `buys` table on every cache miss: every
 *      amount concatenated into one string per motif, split again in
 *      JavaScript and summed as BigInt. That is exact, which is the point of
 *      it, and it is also a cost that grows with every trade forever. Because
 *      `node-sqlite3-wasm` is synchronous, that cost was not only the slow
 *      route's: every other request queued behind it, `/healthz` included.
 *
 *      So the sums are kept as they happen. A motif's row here carries its
 *      count, its exact volume and fees as decimal strings, a float copy of
 *      each for ordering only, its distinct buyers and its latest buy. The
 *      routes read one row per motif instead of every buy it ever had.
 *
 *      **Why this cannot quietly go wrong.** The totals are rebuilt from the
 *      rows themselves on every boot, in one pass, so whatever happened to
 *      them while the process was running, a crash between two writes
 *      included, lasts no longer than one restart. In between, the indexer
 *      moves them only when an insert actually added a row: the last sixty
 *      blocks are re-read on every pass to catch a reorganisation, and those
 *      replays are ignored by `INSERT OR IGNORE` before they reach here.
 *
 *      Money stays out of floating point exactly as before. The exact sums
 *      are BigInt in JavaScript and TEXT in SQLite; the REAL columns exist
 *      only so SQL can order by them, which is what the old queries used
 *      `SUM(CAST(... AS REAL))` for too.
 */

type Row = { index_id: number; amount_in: string; creator_fee: string }

export function rebuildTotals(db: DB): { buys: number; ms: number } {
  const started = Date.now()
  let buys = 0
  db.run('BEGIN')
  try {
    for (const table of ['index_totals', 'index_buyers', 'buyers', 'totals']) db.run(`DELETE FROM ${table}`)

    // Distinct buyers, per motif and overall, in SQL where it is one pass.
    db.run('INSERT INTO index_buyers (index_id, buyer) SELECT DISTINCT index_id, buyer FROM buys')
    db.run('INSERT INTO buyers (buyer) SELECT DISTINCT buyer FROM buys')
    const holders = new Map(
      (db.all('SELECT index_id, COUNT(*) AS n FROM index_buyers GROUP BY index_id') as { index_id: number; n: number }[]).map(
        (r) => [r.index_id, r.n],
      ),
    )
    const counts = db.all('SELECT index_id, COUNT(*) AS n, MAX(ts) AS last FROM buys GROUP BY index_id') as {
      index_id: number
      n: number
      last: number | null
    }[]

    // The money in BigInt, never through a double.
    const sums = new Map<number, { volume: bigint; fees: bigint }>()
    let volumeIn = 0n
    for (const r of db.all('SELECT index_id, amount_in, creator_fee FROM buys') as Row[]) {
      const s = sums.get(r.index_id) ?? { volume: 0n, fees: 0n }
      s.volume += BigInt(r.amount_in)
      s.fees += BigInt(r.creator_fee)
      sums.set(r.index_id, s)
      volumeIn += BigInt(r.amount_in)
    }

    for (const c of counts) {
      const s = sums.get(c.index_id) ?? { volume: 0n, fees: 0n }
      db.run(
        `INSERT INTO index_totals (index_id, buys, volume, fees, volume_sort, fees_sort, holders, last_buy_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.index_id, c.n, s.volume.toString(), s.fees.toString(), Number(s.volume), Number(s.fees), holders.get(c.index_id) ?? 0, c.last],
      )
      buys += c.n
    }

    let volumeOut = 0n
    const sells = db.all('SELECT amount_out FROM sells') as { amount_out: string }[]
    for (const s of sells) volumeOut += BigInt(s.amount_out)

    db.run('INSERT INTO totals (id, buys, volume_in, sells, volume_out) VALUES (1, ?, ?, ?, ?)', [
      buys,
      volumeIn.toString(),
      sells.length,
      volumeOut.toString(),
    ])
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  return { buys, ms: Date.now() - started }
}

/** One buy that was actually new. The caller has already inserted the row. */
export function addBuy(
  db: DB,
  b: { index_id: number; buyer: string; amount_in: string; creator_fee: string; ts: number },
): void {
  const cur = db.get('SELECT buys, volume, fees, holders, last_buy_ts FROM index_totals WHERE index_id = ?', [b.index_id]) as
    | { buys: number; volume: string; fees: string; holders: number; last_buy_ts: number | null }
    | undefined
  const newHolder = db.run('INSERT OR IGNORE INTO index_buyers (index_id, buyer) VALUES (?, ?)', [b.index_id, b.buyer]).changes === 1
  db.run('INSERT OR IGNORE INTO buyers (buyer) VALUES (?)', [b.buyer])

  const volume = BigInt(cur?.volume ?? '0') + BigInt(b.amount_in)
  const fees = BigInt(cur?.fees ?? '0') + BigInt(b.creator_fee)
  db.run(
    `INSERT INTO index_totals (index_id, buys, volume, fees, volume_sort, fees_sort, holders, last_buy_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(index_id) DO UPDATE SET
       buys = excluded.buys, volume = excluded.volume, fees = excluded.fees,
       volume_sort = excluded.volume_sort, fees_sort = excluded.fees_sort,
       holders = excluded.holders, last_buy_ts = excluded.last_buy_ts`,
    [
      b.index_id,
      (cur?.buys ?? 0) + 1,
      volume.toString(),
      fees.toString(),
      Number(volume),
      Number(fees),
      (cur?.holders ?? 0) + (newHolder ? 1 : 0),
      Math.max(cur?.last_buy_ts ?? 0, b.ts) || null,
    ],
  )

  // An upsert rather than an UPDATE, so a missing row is created rather than
  // every later buy silently updating nothing.
  const t = db.get('SELECT volume_in FROM totals WHERE id = 1') as { volume_in: string } | undefined
  db.run(
    `INSERT INTO totals (id, buys, volume_in) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET buys = buys + 1, volume_in = excluded.volume_in`,
    [(BigInt(t?.volume_in ?? '0') + BigInt(b.amount_in)).toString()],
  )
}

/** One sell that was actually new. */
export function addSell(db: DB, amountOut: string): void {
  const t = db.get('SELECT volume_out FROM totals WHERE id = 1') as { volume_out: string } | undefined
  db.run(
    `INSERT INTO totals (id, sells, volume_out) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET sells = sells + 1, volume_out = excluded.volume_out`,
    [(BigInt(t?.volume_out ?? '0') + BigInt(amountOut)).toString()],
  )
}
