import { open } from './db.js'

/**
 * A small, deterministic database for testing the api without a chain.
 *
 * `scripts/api-smoke.mjs` calls every route the api advertises, which is how a
 * route that ships broken gets caught. It could only ever run against whatever
 * happened to be indexed locally, so it never ran in CI, so the one thing it is
 * good at catching kept being possible.
 *
 * This exists so it can run anywhere. It is built by opening a database through
 * the ordinary `open`, which applies the real migrations, and then inserting
 * rows. That matters: a fixture with a hand written schema drifts the first
 * time a migration adds a column, and then CI is testing a shape the server no
 * longer has.
 *
 * The contents are chosen to make every route answer something rather than an
 * empty list, because a route that returns `[]` proves far less than one that
 * has to shape a row:
 *
 *   - two motifs, so a leaderboard has something to order
 *   - buys across two blocks, so the keyset cursor has a second page to find
 *   - a sell, a rebalance, an open order and a closed one
 *   - enough levels on one motif for a return, and none on the other, so the
 *     "unknown is not zero" path is exercised rather than assumed
 *
 *   npx tsx src/fixture.ts /tmp/motif-fixture/motif.sqlite
 */

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'
const TSLA = '0x322f0929c4625ed5bad873c95208d54e1c003b2d'
const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c'
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'

const ALICE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const BOB = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

/** Fixed, so two runs of CI produce the same database byte for byte. */
const T0 = 1_780_000_000
const BLOCK = 55_000_000

const path = process.argv[2] ?? './data/fixture.sqlite'

/**
 * This empties tables, so it must not be able to point at a real database by
 * accident. A path has to say it is a fixture, or say so explicitly with the
 * environment variable. `DATA_DIR=./data npx tsx src/fixture.ts data/motif.sqlite`
 * is otherwise a very short command that deletes an indexer's level history,
 * which is the one thing here that cannot be rebuilt.
 */
if (!/fixture/i.test(path) && process.env.MOTIF_FIXTURE_FORCE !== '1') {
  console.error(
    `refusing to write ${path}: the path has to contain "fixture", ` +
      'or set MOTIF_FIXTURE_FORCE=1 if you really mean it',
  )
  process.exit(1)
}

const db = open(path)

// Idempotent: running this twice must not double every row, and CI reruns it.
for (const table of [
  'curve_levels',
  'motif_levels',
  'motif_basis',
  'price_snapshots',
  'keeper_log',
  'subscriptions',
  'orders',
  'sells',
  'rebalances',
  'buys',
  'legs',
  'indexes',
]) {
  db.run(`DELETE FROM ${table}`)
}

db.run(
  `INSERT INTO indexes (id, creator, creator_fee_bps, input, leg_count, block, tx, name, symbol, description, image, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  // One with a picture and one without, on purpose: the grid has to be right in
  // both shapes, and a fixture where every row looks the same tests one of them.
  [
    0, ALICE, 50, USDG, 2, BLOCK, '0x' + 'a1'.repeat(32), 'AI Core', 'AICORE',
    'NVDA and TSLA, sixty forty.', 'https://example.com/aicore.png', T0,
  ],
)
db.run(
  `INSERT INTO indexes (id, creator, creator_fee_bps, input, leg_count, block, tx, name, symbol, description, image, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [1, BOB, 10, USDG, 1, BLOCK + 10, '0x' + 'b2'.repeat(32), 'Just the Index', 'JUSTSPY', '', '', T0 + 60],
)

const legs: [number, number, string, number, number][] = [
  [0, 0, NVDA, 500, 6000],
  [0, 1, TSLA, 3000, 4000],
  [1, 0, SPY, 500, 10_000],
]
for (const l of legs) {
  db.run('INSERT INTO legs (index_id, position, token, fee, weight_bps) VALUES (?, ?, ?, ?, ?)', l)
}

// Two blocks, so `/v1/buys?before=` has somewhere to go.
const buys: [string, number, number, string, string, string, string, number, number][] = [
  ['0x' + 'c3'.repeat(32), 0, 0, ALICE, '3000000000', '15000000', '3000000', BLOCK, T0],
  ['0x' + 'c4'.repeat(32), 0, 0, BOB, '900000000', '4500000', '900000', BLOCK + 20, T0 + 120],
  ['0x' + 'c5'.repeat(32), 1, 1, BOB, '2500000000', '2500000', '2500000', BLOCK + 20, T0 + 130],
]
for (const b of buys) {
  db.run(
    `INSERT INTO buys (tx, log_index, index_id, buyer, amount_in, creator_fee, protocol_fee, block, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    b,
  )
}

db.run(
  `INSERT INTO sells (tx, log_index, index_id, seller, legs, amount_out, block, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ['0x' + 'd6'.repeat(32), 4, 0, ALICE, 2, '1486548880', BLOCK + 30, T0 + 200],
)

db.run(
  `INSERT INTO rebalances (tx, log_index, holder, index_id, drift_before, block, ts)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ['0x' + 'e7'.repeat(32), 2, BOB, 0, 1970, BLOCK + 40, T0 + 300],
)

// One live and one filled, so `/v1/orders` and `?owner=` differ.
db.run(
  'INSERT INTO orders (id, owner, token, kind, amount, active, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [0, ALICE, NVDA, 2, '1000000000000000000', 1, BLOCK + 50, T0 + 400],
)
db.run(
  'INSERT INTO orders (id, owner, token, kind, amount, active, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  [1, BOB, TSLA, 0, '500000000', 0, BLOCK + 51, T0 + 410],
)

db.run(
  'INSERT INTO subscriptions (holder, index_id, drift_bps, active, block, ts) VALUES (?, ?, ?, ?, ?, ?)',
  [BOB, 0, 500, 1, BLOCK + 60, T0 + 500],
)

// Motif 0 gets a history. Motif 1 deliberately gets none, so the leaderboard
// has to drop it from a return ranking rather than sort it as if it were flat.
db.run('INSERT INTO motif_basis (index_id, basis18, at) VALUES (?, ?, ?)', [
  0,
  '100000000000000000000',
  T0,
])
const levels = ['100000000000000000000', '100500000000000000000', '101250000000000000000']
levels.forEach((level18, i) => {
  db.run('INSERT INTO motif_levels (index_id, at, level18) VALUES (?, ?, ?)', [
    0,
    T0 + i * 3600,
    level18,
  ])
})

db.run('INSERT INTO price_snapshots (token, at, price18) VALUES (?, ?, ?)', [
  NVDA,
  T0,
  '231000000000000000000',
])

/**
 * Two basket tokens, one mid raise and one graduated.
 *
 * Both states on purpose: a fixture with only the easy one is how a page that
 * cannot render the other ships green. The numbers are the ones the fork test
 * actually produced for a $10,000 raise, so the shapes here and on chain agree.
 */
db.run(
  `INSERT INTO curves (curve, index_id, creator, vault, pool, threshold, creator_fee_bps, leg_count,
                       name, symbol, description, image, block, tx, ts,
                       raised, sold, supply, graduated, state_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    '0x1111111111111111111111111111111111111111',
    0,
    ALICE,
    '0x2222222222222222222222222222222222222222',
    '0x3333333333333333333333333333333333333333',
    '10000000000',
    50,
    2,
    'AI Core',
    'AICORE',
    'Nvidia and Tesla, sixty forty.',
    // One with a picture and one without, because a grid that only renders one
    // of those is a grid that ships with the other half broken.
    'https://example.invalid/v1/images/deadbeef',
    1000,
    '0xfeed0000000000000000000000000000000000000000000000000000000000c0',
    T0,
    '6300000000',
    '520000000000000000000000000',
    '0',
    0,
    T0,
  ],
)
db.run(
  `INSERT INTO curves (curve, index_id, creator, vault, pool, threshold, creator_fee_bps, leg_count,
                       name, symbol, description, image, block, tx, ts,
                       raised, sold, supply, graduated, state_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    '0x4444444444444444444444444444444444444444',
    1,
    BOB,
    '0x5555555555555555555555555555555555555555',
    '0x6666666666666666666666666666666666666666',
    '10000000000',
    25,
    2,
    'Big Silver',
    'BIGAG',
    '',
    '',
    1001,
    '0xfeed0000000000000000000000000000000000000000000000000000000000c1',
    T0,
    '10000000000',
    '749999999962500000001874999',
    '787499999960904098499751921',
    1,
    T0,
  ],
)

/**
 * A price history for both basket tokens, because a chart that is only ever
 * tested against an empty table is a chart nobody has seen.
 *
 * The raising one gets a curve price that climbs as the raise fills and no
 * floor, since nothing is backing it yet. The graduated one gets a pool price
 * that runs well above its floor and then comes part of the way back, which is
 * the shape the whole design is about: the floor holds and the price does not.
 */
const curvePoints: [string, number, string, string | null][] = []
for (let i = 0; i < 24; i++) {
  const at = T0 + i * 3600
  // Raising: $0.0000133 up to $0.0000533 as the curve fills.
  const raising = 13_300_000_000_000n + BigInt(i) * 1_700_000_000_000n
  curvePoints.push(['0x1111111111111111111111111111111111111111', at, raising.toString(), null])

  // Graduated: opens at 5.3x its backing, runs to 4x that, gives half back.
  const shape = [1, 1.4, 2.1, 3.3, 4.2, 3.1, 2.6, 2.9, 2.2, 1.8, 2.0, 1.7][i % 12]!
  // Opens at $0.0000533 against a $0.0000101 floor, which is the 5.3x the
  // arithmetic actually produces.
  const price = BigInt(Math.round(53_330_000_000_000 * shape))
  const floor = 10_100_000_000_000n + BigInt(i) * 40_000_000_000n
  curvePoints.push(['0x4444444444444444444444444444444444444444', at, price.toString(), floor.toString()])
}
for (const p of curvePoints) {
  db.run('INSERT OR REPLACE INTO curve_levels (curve, at, price18, floor18) VALUES (?, ?, ?, ?)', p)
}

const n = (q: string) => (db.get(q) as { n: number }).n
console.log(
  `[fixture] ${path}: ${n('SELECT COUNT(*) AS n FROM indexes')} motifs, ` +
    `${n('SELECT COUNT(*) AS n FROM buys')} buys, ${n('SELECT COUNT(*) AS n FROM sells')} sells, ` +
    `${n('SELECT COUNT(*) AS n FROM orders')} orders, ${n('SELECT COUNT(*) AS n FROM motif_levels')} levels, ` +
    `${n('SELECT COUNT(*) AS n FROM curves')} curves`,
)
db.close()
