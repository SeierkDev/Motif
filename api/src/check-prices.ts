/**
 * The pool price arithmetic, against exact rational arithmetic.
 *
 * @dev This exists because the shipped version was wrong and nothing noticed.
 *      It was a port of the shifting Solidity does to keep `sqrtP^2` inside 256
 *      bits, into a language whose integers have no width, so the shift bought
 *      nothing and cost precision that grew as the price fell. Stock pools
 *      price around 1e20 and were unaffected, which is why every test passed. A
 *      basket token opens near 5e13.
 *
 *      Checked at both sort orders, because which one a token lands on is
 *      decided only by how its address compares to USDG's, and the old bug was
 *      on one side and not the other. Needs no chain: a `sqrtPriceX96` is built
 *      from a price rather than read from one.
 */
import { priceFromSqrt } from './prices.js'

let bad = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) console.log(`  ok   ${name}`)
  else {
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
    bad++
  }
}

/** Integer square root, so a sqrtPriceX96 can be built from a target ratio. */
function isqrt(n: bigint): bigint {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/** The sqrtPriceX96 a pool holding `token1Raw` against `token0Raw` would report. */
const sqrtPriceFor = (token1Raw: bigint, token0Raw: bigint): bigint =>
  isqrt((token1Raw << 192n) / token0Raw)

/**
 * What the answer should be, worked out from the amounts rather than from a
 * square root, so the two derivations are independent.
 *
 * `usdgRaw` is 6 decimals and `tokenRaw` is 18, and the answer is USDG per
 * whole token scaled by 1e18.
 */
const expected = (usdgRaw: bigint, tokenRaw: bigint): bigint =>
  (usdgRaw * 10n ** 12n * 10n ** 18n) / tokenRaw

/** How far apart two answers are, in parts per million. */
function ppm(got: bigint, want: bigint): number {
  if (want === 0n) return got === 0n ? 0 : Infinity
  const diff = got > want ? got - want : want - got
  return Number((diff * 1_000_000n) / want)
}

const ONE_TOKEN = 10n ** 18n

/**
 * Prices spanning what this system actually quotes: a stock around $232, and a
 * basket token from its opening price down through a thousandfold fall, which
 * is an ordinary life for a launchpad token and is where the old arithmetic
 * stopped answering at all.
 */
const cases: [string, bigint, bigint][] = [
  ['a stock at $232.87', 232_870000n, ONE_TOKEN],
  ['a stock at $0.94', 940000n, ONE_TOKEN],
  ['a basket at its open, $0.0000533', 13_333_330000n, 250_000_000n * ONE_TOKEN],
  ['a basket down 10x', 1_333_333000n, 250_000_000n * ONE_TOKEN],
  ['a basket down 100x', 133_333300n, 250_000_000n * ONE_TOKEN],
  ['a basket down 1,000x', 13_333330n, 250_000_000n * ONE_TOKEN],
  ['a basket down 10,000x', 1_333333n, 250_000_000n * ONE_TOKEN],
]

// A sqrtPriceX96 is itself a rounded number, so the round trip through it can
// never be exact. What is being checked is that the arithmetic adds nothing on
// top of that: ten parts per million is a thousandth of a percent, and the old
// version was 24,000 ppm wrong at "down 100x" and 1,000,000 ppm at "down
// 10,000x", which is to say it returned zero.
const TOLERANCE_PPM = 10

for (const [name, usdgRaw, tokenRaw] of cases) {
  const want = expected(usdgRaw, tokenRaw)

  // usdg is token1: ratio is usdg per token.
  const sqrtHigh = sqrtPriceFor(usdgRaw, tokenRaw)
  const gotHigh = priceFromSqrt(sqrtHigh, false)
  // usdg is token0: ratio is token per usdg, the other way up.
  const sqrtLow = sqrtPriceFor(tokenRaw, usdgRaw)
  const gotLow = priceFromSqrt(sqrtLow, true)

  const e1 = gotHigh === null ? Infinity : ppm(gotHigh, want)
  const e2 = gotLow === null ? Infinity : ppm(gotLow, want)
  check(
    `${name}, usdg sorts second`,
    e1 <= TOLERANCE_PPM,
    `wanted ${want}, got ${gotHigh}, ${e1} ppm out`,
  )
  check(
    `${name}, usdg sorts first`,
    e2 <= TOLERANCE_PPM,
    `wanted ${want}, got ${gotLow}, ${e2} ppm out`,
  )
}

check('an unpriced pool is null rather than zero', priceFromSqrt(0n, false) === null)
check('and null on the other side too', priceFromSqrt(0n, true) === null)

console.log(
  bad ? `${bad} failed` : 'the pool price is exact at both sort orders, across four decades of price',
)
process.exit(bad ? 1 : 0)
