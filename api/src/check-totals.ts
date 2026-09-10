/**
 * The running totals, checked two ways against the rows they summarise.
 *
 *   npx tsx src/check-totals.ts <fixture database>
 *
 * 1. Rebuilt, every motif's totals equal a sum done here directly over its
 *    buys, in BigInt, and the site wide row equals the same over everything.
 * 2. Emptied and replayed one buy at a time through the functions the indexer
 *    calls, they arrive at exactly the rebuild, row for row. A difference
 *    between those two paths would be an api that disagrees with itself after
 *    a restart, which is the kind of wrong nobody would notice.
 */
import { open } from './db.js'
import { addBuy, addSell, rebuildTotals } from './totals.js'

const path = process.argv[2]
if (!path) {
  console.error('usage: npx tsx src/check-totals.ts <database>')
  process.exit(2)
}
const db = open(path)
let failed = 0
const fail = (msg: string) => {
  failed++
  console.error(`FAIL ${msg}`)
}

const snapshot = () =>
  JSON.stringify({
    perMotif: db.all('SELECT * FROM index_totals ORDER BY index_id'),
    perMotifBuyers: db.all('SELECT * FROM index_buyers ORDER BY index_id, buyer'),
    buyers: db.all('SELECT * FROM buyers ORDER BY buyer'),
    site: db.all('SELECT * FROM totals'),
  })

type Buy = { index_id: number; buyer: string; amount_in: string; creator_fee: string; ts: number }
const buys = db.all('SELECT * FROM buys ORDER BY block, log_index') as Buy[]
const sells = db.all('SELECT amount_out FROM sells ORDER BY block, log_index') as { amount_out: string }[]
if (buys.length === 0) fail('the database has no buys, so this would check nothing')

// 1. Against a direct sum.
rebuildTotals(db)
const want = new Map<number, { buys: number; volume: bigint; fees: bigint; holders: Set<string>; last: number }>()
for (const b of buys) {
  const w = want.get(b.index_id) ?? { buys: 0, volume: 0n, fees: 0n, holders: new Set<string>(), last: 0 }
  w.buys++
  w.volume += BigInt(b.amount_in)
  w.fees += BigInt(b.creator_fee)
  w.holders.add(b.buyer)
  w.last = Math.max(w.last, b.ts)
  want.set(b.index_id, w)
}
for (const [id, w] of want) {
  const got = db.get('SELECT * FROM index_totals WHERE index_id = ?', [id]) as
    | { buys: number; volume: string; fees: string; holders: number; last_buy_ts: number }
    | undefined
  if (!got) {
    fail(`motif ${id} has buys and no totals`)
    continue
  }
  if (got.buys !== w.buys) fail(`motif ${id}: ${got.buys} buys, the rows say ${w.buys}`)
  if (got.volume !== w.volume.toString()) fail(`motif ${id}: volume ${got.volume}, the rows say ${w.volume}`)
  if (got.fees !== w.fees.toString()) fail(`motif ${id}: fees ${got.fees}, the rows say ${w.fees}`)
  if (got.holders !== w.holders.size) fail(`motif ${id}: ${got.holders} holders, the rows say ${w.holders.size}`)
  if (got.last_buy_ts !== w.last) fail(`motif ${id}: last buy ${got.last_buy_ts}, the rows say ${w.last}`)
}
const site = db.get('SELECT * FROM totals WHERE id = 1') as
  | { buys: number; volume_in: string; sells: number; volume_out: string }
  | undefined
const sum = (xs: string[]) => xs.reduce((a, x) => a + BigInt(x), 0n).toString()
if (!site) fail('no site wide totals row')
else {
  if (site.buys !== buys.length) fail(`site: ${site.buys} buys, the rows say ${buys.length}`)
  if (site.volume_in !== sum(buys.map((b) => b.amount_in))) fail('site: volume in differs from the rows')
  if (site.sells !== sells.length) fail(`site: ${site.sells} sells, the rows say ${sells.length}`)
  if (site.volume_out !== sum(sells.map((s) => s.amount_out))) fail('site: volume out differs from the rows')
}
const distinct = new Set(buys.map((b) => b.buyer)).size
const buyers = (db.get('SELECT COUNT(*) AS n FROM buyers') as { n: number }).n
if (buyers !== distinct) fail(`${buyers} buyers counted, the rows say ${distinct}`)

// 2. Replayed through the indexer's path.
const rebuilt = snapshot()
for (const t of ['index_totals', 'index_buyers', 'buyers', 'totals']) db.run(`DELETE FROM ${t}`)
for (const b of buys) addBuy(db, b)
for (const s of sells) addSell(db, s.amount_out)
if (snapshot() !== rebuilt) fail('replaying the buys one at a time does not arrive at the rebuild')

// Leave the database as the api would find it.
rebuildTotals(db)
db.close()
if (failed > 0) process.exit(1)
console.log(
  `totals match: ${want.size} motifs, ${buys.length} buys, ${sells.length} sells, ` +
    'summed directly and replayed one at a time',
)
