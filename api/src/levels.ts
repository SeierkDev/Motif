import type { PublicClient } from 'viem'
import type { DB } from './db.js'
import { poolPrice, reader } from './prices.js'
import { chainPace } from './rpc.js'
import { parseAbi, type Address } from 'viem'

const SWEEP_MS = Number(process.env.MOTIF_LEVEL_MS ?? 60_000)
const ONE = 100n * 10n ** 18n // a motif starts at 100

/** BasketCurve's constants, so the curve price needs no call to read. */
const VIRTUAL_TOKENS = 1_000_000_000n * 10n ** 18n
/** The fee tier BasketCurve opens its pool at. */
const LP_FEE = 3000

/**
 * How many basket tokens one sweep will price.
 *
 * @dev The same bound and the same reason as the indexer's curve refresh: a
 *      graduated row costs three rpc calls, so without this the length of a
 *      sweep is set by how many baskets have ever been launched rather than by
 *      anything the timer controls, against an rpc that rate limits.
 */
const CURVES_PER_SWEEP = 200

const vaultAbi = parseAbi([
  'function backingOf(uint256 amount) view returns (address[] tokens, uint256[] amounts)',
])

type Leg = { token: string; fee: number; weight_bps: number }

/**
 * @title Levels
 * @notice What a motif is worth, recorded as it happens.
 *
 * A motif has no supply and no price of its own, so there is nothing on chain
 * to read. Its value is simply the weighted price of its legs, and a level is
 * that value quoted against whatever it was when the motif was first observed.
 * Every motif therefore starts at 100 on its own launch day rather than against
 * some shared epoch, which is what makes two motifs launched months apart
 * comparable at all.
 *
 * **This is the part that cannot be backfilled.** Volume and fees are events
 * and can be re-read from the chain forever. A level is a reading of a price
 * that has already gone. Every sweep that does not happen is a hole nobody can
 * fill later, including us, which is why this runs from the first day rather
 * than being added when somebody asks for a chart.
 */
export class Levels {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private client: PublicClient

  lastSweepAt = 0
  lastError: string | null = null
  tracked = 0

  constructor(private db: DB) {
    this.client = reader()
  }

  start() {
    const tick = () => {
      this.sweep().finally(() => {
        this.timer = setTimeout(tick, SWEEP_MS)
      })
    }
    tick()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async sweep(): Promise<void> {
    if (this.running) return
    this.running = true
    const at = Math.floor(Date.now() / 1000)
    try {
      // One read per distinct token and fee tier, not per leg. A dozen motifs
      // sharing NVDA should cost one call, not a dozen.
      const pairs = this.db.all(
        'SELECT DISTINCT token, fee FROM legs',
      ) as { token: string; fee: number }[]

      const prices = new Map<string, bigint>()
      for (const p of pairs) {
        try {
          // Through the same gate every other chain read in this process goes
          // through. Twelve tickers leaving at once is a burst, and it is the
          // one this sweep sends every minute from the moment the api starts.
          await chainPace.next()
          const price = await poolPrice(this.client, p.token as Address, p.fee)
          if (price && price > 0n) {
            prices.set(p.token.toLowerCase(), price)
            this.db.run(
              'INSERT OR REPLACE INTO price_snapshots (token, at, price18) VALUES (?, ?, ?)',
              [p.token.toLowerCase(), at, price.toString()],
            )
          }
        } catch {
          // One unreadable pool must not cost the whole sweep. A motif that
          // depends on it is skipped below rather than recorded wrong.
        }
      }

      const ids = (this.db.all('SELECT id FROM indexes ORDER BY id') as { id: number }[]).map(
        (r) => r.id,
      )
      let n = 0
      for (const id of ids) {
        const legs = this.db.all(
          'SELECT token, fee, weight_bps FROM legs WHERE index_id = ? ORDER BY position',
          [id],
        ) as Leg[]
        if (legs.length === 0) continue

        // The weighted price of one unit of the basket, in 1e18 USDG.
        let basket = 0n
        let complete = true
        for (const leg of legs) {
          const price = prices.get(leg.token.toLowerCase())
          if (!price) {
            complete = false
            break
          }
          basket += (price * BigInt(leg.weight_bps)) / 10_000n
        }
        // A partial basket would print a level that looks like a crash. Skip.
        if (!complete || basket === 0n) continue

        const basisRow = this.db.get('SELECT basis18 FROM motif_basis WHERE index_id = ?', [id]) as
          | { basis18: string }
          | undefined

        if (!basisRow) {
          this.db.run(
            'INSERT OR REPLACE INTO motif_basis (index_id, basis18, at) VALUES (?, ?, ?)',
            [id, basket.toString(), at],
          )
          this.db.run(
            'INSERT OR REPLACE INTO motif_levels (index_id, at, level18) VALUES (?, ?, ?)',
            [id, at, ONE.toString()],
          )
          n++
          continue
        }

        const basis = BigInt(basisRow.basis18)
        if (basis === 0n) continue
        const level = (basket * ONE) / basis
        this.db.run('INSERT OR REPLACE INTO motif_levels (index_id, at, level18) VALUES (?, ?, ?)', [
          id,
          at,
          level.toString(),
        ])
        n++
      }

      await this.sweepCurves(at, prices)

      this.tracked = n
      this.lastSweepAt = Date.now()
      this.lastError = null
    } catch (e) {
      this.lastError = (e as Error).message
    } finally {
      this.running = false
    }
  }

  /**
   * What each basket token is worth, and what it can be redeemed for.
   *
   * @dev **Before graduation this costs no rpc call at all.** The curve's price
   *      is `usdgReserve / tokenReserve`, both of which are arithmetic on
   *      `raised` and `sold`, and the indexer already polls those into the
   *      `curves` table every twenty seconds. Reading them back off the chain a
   *      second time on this timer would double the request rate against an rpc
   *      that already rate limits, to learn a number that is at worst twenty
   *      seconds old, on a chart drawn once a minute.
   *
   *      After graduation the price is whatever the token's own pool says,
   *      which does need reading, and so does the floor. `backingOf(1e18)`
   *      answers "what is one whole token backed by" in a single call, and the
   *      leg prices are the ones already fetched above for the motifs, so a
   *      basket token whose legs no motif holds is the only case that costs
   *      anything extra.
   *
   *      One unreadable curve is skipped rather than recorded wrong. A missing
   *      reading is a gap in a line; a wrong one is a crash that never happened.
   */
  private async sweepCurves(at: number, prices: Map<string, bigint>): Promise<void> {
    // Bounded, like the indexer's own curve refresh. Every graduated row here
    // costs three rpc calls, so an unbounded scan is a sweep whose length is
    // set by how many baskets have ever launched, against an endpoint that
    // rate limits. Newest first, because those are the ones being looked at.
    const rows = this.db.all(
      `SELECT curve, vault, pool, index_id, threshold, raised, sold, graduated
         FROM curves ORDER BY block DESC LIMIT ${CURVES_PER_SWEEP}`,
    ) as {
      curve: string
      vault: string
      pool: string
      index_id: number
      threshold: string
      raised: string
      sold: string
      graduated: number
    }[]

    for (const row of rows) {
      try {
        let price: bigint | null = null
        let floor: bigint | null = null

        if (row.graduated === 1) {
          await chainPace.next()
          // The launch log carried the pool's address, so asking the factory
          // for it again is a request whose answer is already in this row.
          price = await poolPrice(this.client, row.vault as Address, LP_FEE, row.pool as Address)
          floor = await this.backingPerToken(row.vault as Address, row.index_id, prices)
        } else {
          const threshold = BigInt(row.threshold || '0')
          if (threshold === 0n) continue
          // Rounded up, exactly as the constructor does it.
          const virtualUsdg = (threshold + 2n) / 3n
          const usdg = virtualUsdg + BigInt(row.raised || '0')
          const tokens = VIRTUAL_TOKENS - BigInt(row.sold || '0')
          // usdg is 6 decimals and tokens are 18, so 1e30 carries both the
          // difference and the 1e18 the answer is quoted in.
          if (tokens > 0n) price = (usdg * 10n ** 30n) / tokens
        }

        if (price === null || price <= 0n) continue
        this.db.run(
          'INSERT OR REPLACE INTO curve_levels (curve, at, price18, floor18) VALUES (?, ?, ?, ?)',
          [row.curve, at, price.toString(), floor === null ? null : floor.toString()],
        )
      } catch {
        // Skipped, for the reason above.
      }
    }
  }

  /**
   * USDG behind one whole basket token, 1e18, or null when it cannot be priced.
   *
   * @dev Every leg has to have a price or the answer is thrown away. A floor
   *      computed from three of four legs is not a low estimate of the floor,
   *      it is a different number that looks like one, and it would be drawn
   *      under a price as though it meant something.
   */
  private async backingPerToken(
    vault: Address,
    indexId: number,
    prices: Map<string, bigint>,
  ): Promise<bigint | null> {
    await chainPace.next()
    const [tokens, amounts] = (await this.client.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: 'backingOf',
      args: [10n ** 18n],
    })) as readonly [readonly string[], readonly bigint[]]

    if (tokens.length === 0) return null
    let total = 0n
    for (let i = 0; i < tokens.length; i++) {
      const key = tokens[i]!.toLowerCase()
      let price = prices.get(key)
      if (!price) {
        // A leg no motif holds was never priced above. Look up the fee tier the
        // index published for it rather than guessing one.
        const leg = this.db.get(
          'SELECT fee FROM legs WHERE index_id = ? AND lower(token) = ? LIMIT 1',
          [indexId, key],
        ) as { fee: number } | undefined
        if (!leg) return null
        await chainPace.next()
        const read = await poolPrice(this.client, tokens[i] as Address, leg.fee)
        if (!read || read <= 0n) return null
        prices.set(key, read)
        price = read
      }
      total += (amounts[i]! * price) / 10n ** 18n
    }
    return total > 0n ? total : null
  }

  /** Price and floor over time for one basket token, newest first. */
  curveHistory(curve: string, limit = 500) {
    return this.db.all(
      'SELECT at, price18, floor18 FROM curve_levels WHERE curve = ? ORDER BY at DESC LIMIT ?',
      [curve.toLowerCase(), limit],
    )
  }

  /**
   * Level now, and the return over a window, in basis points.
   *
   * Returns null rather than zero when there is nothing to compare against,
   * because "flat" and "we have not been watching long enough" are different
   * answers and a leaderboard that conflates them is lying.
   */
  performance(id: number): {
    level: string | null
    since: number | null
    changeBps: Record<string, number | null>
  } {
    const latest = this.db.get(
      'SELECT at, level18 FROM motif_levels WHERE index_id = ? ORDER BY at DESC LIMIT 1',
      [id],
    ) as { at: number; level18: string } | undefined
    if (!latest) return { level: null, since: null, changeBps: {} }

    const now = BigInt(latest.level18)
    const windows: Record<string, number> = { h1: 3600, h24: 86_400, d7: 604_800 }
    const changeBps: Record<string, number | null> = {}

    for (const [name, seconds] of Object.entries(windows)) {
      const then = this.db.get(
        'SELECT level18 FROM motif_levels WHERE index_id = ? AND at <= ? ORDER BY at DESC LIMIT 1',
        [id, latest.at - seconds],
      ) as { level18: string } | undefined
      if (!then) {
        changeBps[name] = null
        continue
      }
      const before = BigInt(then.level18)
      changeBps[name] = before === 0n ? null : Number(((now - before) * 10_000n) / before)
    }

    const basis = this.db.get('SELECT at FROM motif_basis WHERE index_id = ?', [id]) as
      | { at: number }
      | undefined
    changeBps.inception = Number(((now - ONE) * 10_000n) / ONE)

    return { level: latest.level18, since: basis?.at ?? null, changeBps }
  }

  history(id: number, limit = 500) {
    return this.db.all(
      'SELECT at, level18 FROM motif_levels WHERE index_id = ? ORDER BY at DESC LIMIT ?',
      [id, limit],
    )
  }

  status() {
    const points = (this.db.get('SELECT COUNT(*) AS n FROM motif_levels') as { n: number }).n
    const oldest = this.db.get('SELECT MIN(at) AS a FROM motif_levels') as { a: number | null }
    return {
      lastSweepAt: this.lastSweepAt || null,
      secondsSinceSweep: this.lastSweepAt
        ? Math.round((Date.now() - this.lastSweepAt) / 1000)
        : null,
      motifsPriced: this.tracked,
      pointsRecorded: points,
      curvePointsRecorded: (this.db.get('SELECT COUNT(*) AS n FROM curve_levels') as { n: number })
        .n,
      recordingSince: oldest?.a ?? null,
      error: this.lastError,
    }
  }
}
