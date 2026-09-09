/*
 * Hit every route the api advertises and fail on the first one that does not
 * answer.
 *
 * The list is not written here. It is read from the api's own 404 body, so a
 * route added to the server without a check here shows up as an unfilled
 * placeholder rather than passing quietly. That matters: /v1/creators/:address
 * shipped with a broken query for weeks because nothing had ever called it.
 *
 *   node scripts/api-smoke.mjs [base]
 */
const base = process.argv[2] ?? process.env.MOTIF_API ?? 'http://127.0.0.1:8787'

const get = async (path) => {
  const res = await fetch(base + path)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const fail = (msg) => {
  console.error('FAIL ' + msg)
  process.exitCode = 1
}

const health = await get('/healthz')
if (health.status !== 200) {
  console.error(`no api at ${base} (${health.status}). Start it with: cd api && npm start`)
  process.exit(1)
}

const { body: notFound } = await get('/v1/__routes__')
const advertised = (notFound?.routes ?? []).filter((r) => r.startsWith('GET '))
if (advertised.length === 0) {
  console.error('the api did not advertise any routes')
  process.exit(1)
}

// Real ids to fill the placeholders with, taken from the running index.
const { body: indexes } = await get('/v1/indexes?limit=1')
const first = indexes?.indexes?.[0]
if (!first) {
  console.error('the api has indexed nothing yet, so :id routes cannot be checked')
  process.exit(1)
}

/*
 * A real image, uploaded here so that the :sha256 route has something to fill
 * its placeholder with.
 *
 * Built rather than checked in, because a one pixel png is 69 bytes of header
 * and a binary fixture in the repo is a thing nobody can read a diff of. It
 * also means this exercises the write path, which is the only one in the api.
 */
const onePixelPng = (() => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  // zlib stream for a single black pixel, stored uncompressed.
  const idat = Buffer.from([0x78, 0x01, 0x01, 0x02, 0x00, 0xfd, 0xff, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
})()

const upload = await fetch(base + '/v1/images', { method: 'POST', body: onePixelPng })
const uploaded = await upload.json().catch(() => null)
if (upload.status !== 200 || !uploaded?.hash) {
  console.error(`POST /v1/images answered ${upload.status}: ${JSON.stringify(uploaded)}`)
  process.exit(1)
}

// A curve address, so /v1/curves/:curve has something real to be asked about.
const { body: curveList } = await get('/v1/curves?limit=1')
const firstCurve = curveList?.curves?.[0]
if (!firstCurve) {
  console.error('the api has no curves, so /v1/curves/:curve cannot be checked')
  process.exit(1)
}

const fills = {
  ':id': String(first.id),
  ':address': first.creator,
  ':sha256': uploaded.hash,
  ':curve': firstCurve.curve,
}

// Variants worth checking beyond the bare route: every sort key, both pages of
// a keyset walk, a window, and an address filter.
const extra = [
  '/v1/leaderboard?by=volume',
  '/v1/leaderboard?by=fees',
  '/v1/leaderboard?by=buys',
  '/v1/leaderboard?by=new',
  '/v1/leaderboard?by=return',
  '/v1/leaderboard?by=worst',
  '/v1/trending?hours=1',
  '/v1/trending?hours=720',
  `/v1/indexes/${first.id}/history?limit=5`,
  `/v1/orders?owner=${first.creator}`,
  '/v1/buys?limit=1',
]

let checked = 0
for (const line of [...advertised.map((r) => r.slice(4).trim()), ...extra]) {
  let path = line.split('?')[0]
  const query = line.includes('?') && extra.includes(line) ? line.slice(line.indexOf('?')) : ''
  for (const [placeholder, value] of Object.entries(fills)) path = path.replaceAll(placeholder, value)
  if (path.includes(':')) {
    fail(`${path} has a placeholder this script does not know how to fill`)
    continue
  }
  const { status, body } = await get(path + query)
  checked++
  if (status !== 200) fail(`${status} ${path}${query} ${body?.error ?? ''}`)
  else if (body?.error) fail(`200 with an error body: ${path}${query} ${body.error}`)
  else console.log(`  ok  ${path}${query}`)
}

/*
 * The image store, which is the only thing here that is written to.
 *
 * Content addressed, so the three claims worth checking are that the url is the
 * hash of what comes back, that a file which is not an image is refused on its
 * bytes rather than on what the request said it was, and that an unknown hash
 * is a 404 rather than anything else.
 */
{
  const res = await fetch(base + uploaded.path)
  const bytes = Buffer.from(await res.arrayBuffer())
  checked++
  if (res.status !== 200) fail(`${uploaded.path}: ${res.status}`)
  else if (!bytes.equals(onePixelPng)) fail('the image came back as different bytes')
  else if (res.headers.get('content-type') !== 'image/png') {
    fail(`served as ${res.headers.get('content-type')} rather than image/png`)
  } else console.log('  ok  an uploaded image comes back byte for byte')

  const again = await fetch(base + '/v1/images', { method: 'POST', body: onePixelPng })
  const twice = await again.json().catch(() => null)
  checked++
  if (twice?.hash !== uploaded.hash) fail('the same file uploaded twice got two different urls')
  else console.log('  ok  the same file is the same url')

  const notAnImage = await fetch(base + '/v1/images', {
    method: 'POST',
    body: Buffer.from('<svg onload="alert(1)"></svg>'),
  })
  checked++
  if (notAnImage.status !== 415) fail(`a non image uploaded as one answered ${notAnImage.status}`)
  else console.log('  ok  only real images are stored')

  const missing = await fetch(base + `/v1/images/${'0'.repeat(64)}`)
  checked++
  if (missing.status !== 404) fail(`an unknown image hash answered ${missing.status}`)
  else console.log('  ok  an unknown image is a 404')
}

/*
 * A basket token's price history.
 *
 * The two claims worth pinning: money comes back as decimal strings, and a
 * reading taken before graduation carries a null floor rather than a zero. A
 * client that drew zero would be putting a floor line along the bottom of a
 * chart for a token that has nothing behind it at all.
 */
{
  /*
   * At least one, not the newest one. A curve launched a second ago has no
   * readings yet and that is correct rather than broken, so asserting on
   * whichever happens to be first is a check that fails on the truth.
   */
  const all = (await get('/v1/curves?limit=60')).body?.curves ?? []
  const histories = []
  for (const c of all) {
    const { status, body } = await get(`/v1/curves/${c.curve}/history`)
    checked++
    if (status !== 200) {
      fail(`curve history for ${c.curve}: ${status}`)
      continue
    }
    if (!Array.isArray(body?.levels)) {
      fail(`curve history for ${c.curve} is not a list`)
      continue
    }
    histories.push({ curve: c, levels: body.levels })
  }

  const withPoints = histories.filter((h) => h.levels.length > 0)
  checked++
  if (withPoints.length === 0) fail('no basket token has any price history at all')
  else if (typeof withPoints[0].levels[0].price18 !== 'string') {
    fail(`price18 came back as ${typeof withPoints[0].levels[0].price18}, and it has to be a string`)
  } else console.log(`  ok  ${withPoints.length} basket token(s) have a price history`)

  // Nothing that has not graduated may claim a floor: there is no vault
  // holding anything yet, and a zero there would be a different statement.
  const wrong = histories
    .filter((h) => !h.curve.graduated)
    .flatMap((h) => h.levels.filter((p) => p.floor18 !== null))
  checked++
  if (wrong.length > 0) fail(`a curve still raising reported a floor on ${wrong.length} reading(s)`)
  else console.log('  ok  nothing raising claims a floor')
}

// Keyset paging has to actually move, or it silently serves page one forever.
const page1 = await get('/v1/buys?limit=1')
if (page1.body?.next) {
  const page2 = await get(`/v1/buys?limit=1&before=${page1.body.next}`)
  checked++
  if (page2.status !== 200) fail(`paging: ${page2.status}`)
  else if (page2.body.buys[0] && page2.body.buys[0].tx === page1.body.buys[0].tx)
    fail('paging returned the same buy twice')
  else console.log('  ok  keyset paging moves')
}

/*
 * Moving is not enough: it has to reach everything.
 *
 * The cursor used to be a block number, and a block is not a position. Two buys
 * in one block meant the next page started after the whole block and the rest of
 * it was never served by any cursor. Measured on this fixture, which holds three
 * buys with two of them in one block: paging with limit=1 returned two of the
 * three, and the third was unreachable.
 *
 * So this walks the whole feed one row at a time and counts, rather than
 * checking that two pages differ.
 */
for (const feed of ['buys', 'sells']) {
  checked++
  const seen = new Set()
  let cursor = null
  for (let i = 0; i < 200; i++) {
    const page = await get(`/v1/${feed}?limit=1${cursor ? `&before=${cursor}` : ''}`)
    if (page.status !== 200) break
    for (const row of page.body[feed]) seen.add(`${row.tx}:${row.log_index}`)
    if (!page.body.next) break
    cursor = page.body.next
  }
  const { body: all } = await get(`/v1/${feed}?limit=500`)
  const total = (all?.[feed] ?? []).length
  if (seen.size !== total) {
    fail(`paging /v1/${feed} one at a time reached ${seen.size} of ${total} rows`)
  } else {
    console.log(`  ok  paging /v1/${feed} reaches every one of its ${total} rows`)
  }
}

/*
 * `/v1/status` reports exactly the fields the sdk says it does.
 *
 * The sdk's `Status` type had drifted: the route grew a keeper block, a levels
 * block, two config fields and two chain addresses, and the type kept
 * describing the api from before any of them existed. That is worse than being
 * untyped, because it tells a consumer those fields are not there, and the
 * three things it hid are the three things this route exists for.
 *
 * Compared as a set in both directions on purpose. A missing field is a broken
 * api; an *extra* one is the api having grown without the typed client, which
 * is the direction that actually happened and the direction nothing would
 * otherwise notice. When this fails, update packages/sdk/src/index.ts as well
 * as the list below.
 */
{
  const expected = {
    '': [
      'ok', 'indexer', 'keeper', 'levels', 'chain', 'storage', 'migrations',
      'uptimeSeconds', 'subscribers',
    ],
    indexer: ['lastBlock', 'lastRunAt', 'secondsSinceRun', 'error', 'configError', 'configWarning'],
    keeper: [
      'enabled', 'address', 'state', 'keyError', 'stoppedReason', 'throttle',
      'fired', 'lastSweepAt', 'secondsSinceSweep', 'watching', 'recent',
    ],
    levels: [
      'lastSweepAt', 'secondsSinceSweep', 'motifsPriced', 'pointsRecorded',
      'curvePointsRecorded', 'recordingSince', 'error',
    ],
    chain: ['rpc', 'router', 'rebalancer', 'orders', 'factory'],
    storage: ['total', 'main', 'wal', 'images'],
  }
  const { body: status } = await get('/v1/status')
  for (const [path, want] of Object.entries(expected)) {
    checked++
    const got = Object.keys(path === '' ? (status ?? {}) : (status?.[path] ?? {}))
    const missing = want.filter((k) => !got.includes(k))
    const extra = got.filter((k) => !want.includes(k))
    const where = path === '' ? '/v1/status' : `/v1/status ${path}`
    if (missing.length || extra.length) {
      fail(
        `${where} does not match the sdk's Status type` +
          (missing.length ? `, missing ${missing.join(', ')}` : '') +
          (extra.length ? `, undocumented ${extra.join(', ')}` : ''),
      )
    } else {
      console.log(`  ok  ${where} matches the sdk's Status type`)
    }
  }
}

/*
 * A few things the routes are supposed to mean, not just answer.
 *
 * Cheap, and they cover the two claims most likely to regress quietly: that a
 * motif with no reading yet is dropped from a return ranking rather than sorted
 * as if it were flat, and that money is carried as a decimal string rather than
 * a double that loses its low bits above 2^53.
 */
const { body: ranked } = await get('/v1/leaderboard?by=return')
checked++
const unrated = (ranked?.indexes ?? []).filter((m) => !m.performance || m.performance.level === null)
if (unrated.length > 0) {
  fail(`by=return ranked ${unrated.length} motif(s) with no reading yet, which is not "flat"`)
} else {
  console.log('  ok  return ranking drops motifs with no reading')
}

const { body: byVolume } = await get('/v1/leaderboard?by=volume')
checked++
const withVolume = (byVolume?.indexes ?? []).find((m) => m.volume !== undefined)
if (!withVolume) {
  fail('no motif carried a volume, so the type could not be checked')
} else if (typeof withVolume.volume !== 'string') {
  fail(`volume came back as ${typeof withVolume.volume}, and it has to be a string`)
} else {
  console.log('  ok  volume and fees are decimal strings')
}

/*
 * The front page average has to agree with the per motif numbers it averages.
 *
 * These are computed twice from different tables: `averageMoveBps` on
 * /v1/stats reads the latest level of every motif, and
 * `performance.changeBps.inception` on the leaderboard is worked out per motif
 * by `perf`. Two independent paths to the same figure, which is the only
 * reason the first one shipping wrong was catchable: it divided the level by
 * the raw basket price instead of the level's own base of 100, and published
 * +82.68% for a set of motifs actually spread between +0.95% and -1.95%.
 * Nothing threw. The number simply looked like a number.
 */
const { body: statsForAvg } = await get('/v1/stats')
const { body: boardForAvg } = await get('/v1/leaderboard?by=new')
checked++
const inceptions = (boardForAvg?.indexes ?? [])
  .map((m) => m.performance?.changeBps?.inception)
  .filter((v) => typeof v === 'number')

if (inceptions.length === 0) {
  console.log('  ok  no motif has a reading yet, so there is no average to check')
} else if (statsForAvg?.averageMoveBps === null || statsForAvg?.averageMoveBps === undefined) {
  fail(`${inceptions.length} motif(s) have a reading but /v1/stats reported no average`)
} else {
  const expected = Math.round(inceptions.reduce((a, b) => a + b, 0) / inceptions.length)
  // A basis point of slack, because the two paths round at different moments.
  if (Math.abs(expected - statsForAvg.averageMoveBps) > 1) {
    fail(
      `averageMoveBps is ${statsForAvg.averageMoveBps} but the motifs it averages come to ${expected}`,
    )
  } else {
    console.log(
      `  ok  averageMoveBps (${statsForAvg.averageMoveBps}) agrees with the motifs it averages`,
    )
  }
}

console.log(
  process.exitCode ? `\n${checked} checked, failures above` : `\n${checked} checks ok at ${base}`,
)
