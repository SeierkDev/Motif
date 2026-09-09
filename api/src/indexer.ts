import { createPublicClient, http, isAddress, parseAbiItem, type PublicClient } from 'viem'
import type { DB } from './db.js'
import { chainPace } from './rpc.js'

/**
 * What a fresh anvil deterministically produces, which is why these can be
 * defaults at all: locally they are always right and nobody has to configure
 * anything. Against any real chain they are addresses with no contract on them.
 */
const LOCAL_DEFAULTS = {
  MOTIF_ROUTER: '0x512F7469BcC83089497506b5df64c6E246B39925',
  MOTIF_REBALANCER: '0x9fD16eA9E31233279975D99D5e8Fc91dd214c7Da',
  MOTIF_ORDERS: '0x987e855776C03A4682639eEb14e65b3089EE6310',
} as const

const RPC = process.env.MOTIF_RPC ?? 'https://rpc.mainnet.chain.robinhood.com'
const ROUTER = (process.env.MOTIF_ROUTER ?? LOCAL_DEFAULTS.MOTIF_ROUTER) as `0x${string}`
const REBALANCER = (process.env.MOTIF_REBALANCER ??
  LOCAL_DEFAULTS.MOTIF_REBALANCER) as `0x${string}`
const ORDERS = (process.env.MOTIF_ORDERS ?? LOCAL_DEFAULTS.MOTIF_ORDERS) as `0x${string}`

/**
 * The factory, and it is optional on purpose.
 *
 * Unlike the three above it has no local default and an unset value is not a
 * misconfiguration: the tokenised basket contracts are not deployed anywhere
 * yet, and an api that refused to start without them would be an api that
 * cannot run against the router that is actually live. Unset means the curve
 * scan is skipped and `/v1/curves` is empty, which is the truth rather than an
 * error. A value that is set and not an address is still reported, because that
 * one is a typo rather than a decision.
 */
const FACTORY = (process.env.MOTIF_FACTORY ?? '').trim()
export const hasFactory = (): boolean => isAddress(FACTORY)

/** The factory actually being indexed, and null when there is not one. */
export const factoryAddress = (): string | null => (hasFactory() ? FACTORY : null)

/**
 * A factory variable that was set to something that is not an address.
 *
 * @dev A warning rather than an error, and the distinction is the point. Unset
 *      is a decision and indexing everything else is right. A typo is a
 *      mistake, and it must not stop the router being indexed either, so it
 *      cannot join `configProblems`. What it must not do is look like the
 *      decision: without this, `/v1/status` echoed the raw variable under
 *      `chain.factory`, so a service that had silently stopped looking for
 *      launches reported the address it was not using.
 */
export function factoryProblem(): string | null {
  if (FACTORY === '' || isAddress(FACTORY)) return null
  return (
    `MOTIF_FACTORY is not an address: ${JSON.stringify(FACTORY)}. ` +
    'No launches are being indexed and /v1/curves is empty.'
  )
}

/** How often the moving half of a curve's state is re-read. */
const CURVE_REFRESH_MS = 20_000

/** An rpc on this machine, which is the only place the defaults above mean anything. */
function isLocalRpc(url: string): boolean {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url)
}

/**
 * The contract addresses that are not addresses.
 *
 * These three are filled in from a deploy, so before one has happened they
 * hold whatever placeholder was typed into the hosting dashboard. viem does
 * not catch that: `getLogs` hands the string to the rpc rather than checking
 * it, so a placeholder is not a startup error, it is an indexer that fails
 * every pass forever with whatever wording the rpc chose for a bad parameter.
 * Checked once, here, in the words of the variable that is wrong.
 *
 * There is deliberately no falling back to the defaults above. Those are the
 * deterministic addresses of a fresh anvil, which is right locally and wrong
 * on every real network: indexing them anyway would leave a service that is
 * healthy, empty, and reading an address with no contract on it, which looks
 * exactly like a launchpad nobody has used yet.
 */
export function configProblems(): string[] {
  const problems: string[] = []
  const local = isLocalRpc(RPC)
  for (const [name, value] of [
    ['MOTIF_ROUTER', ROUTER],
    ['MOTIF_REBALANCER', REBALANCER],
    ['MOTIF_ORDERS', ORDERS],
  ] as const) {
    // strict, so a lower case address passes and a mixed case one with a
    // broken checksum does not. That is the same rule check-addresses.ts
    // applies to the addresses written into the source.
    if (!isAddress(value)) {
      problems.push(`${name} is not an address: ${JSON.stringify(value)}`)
      continue
    }
    // A valid address is not the same as the right one, and this is the pairing
    // that fails silently: an anvil address against a real chain is a perfectly
    // well formed getLogs that succeeds and returns nothing, every pass,
    // forever. No error is raised anywhere, so the service reports itself
    // healthy and the site is simply empty, which is indistinguishable from a
    // launchpad nobody has used. Deleting the variable reaches this state as
    // surely as pasting the address does, so the check is on the value.
    if (!local && value.toLowerCase() === LOCAL_DEFAULTS[name].toLowerCase()) {
      problems.push(
        `${name} is a local anvil address and ${RPC} is not a local rpc, ` +
          'so there is no contract at it. Set it from a deploy.',
      )
    }
  }
  return problems
}

/**
 * Read MOTIF_FROM_BLOCK, which is a block number and is frequently not one.
 *
 * `BigInt()` throws on anything that is not a number, and it used to be called
 * in main.ts at the top level, before `server.listen` had bound. So a variable
 * still holding its placeholder killed the process on boot and the deploy
 * failed as a healthcheck timing out after five minutes, with "Cannot convert
 * <from deploy> to a BigInt" as the only thing said about it.
 *
 * Unlike the addresses this one falls back rather than refusing, because the
 * default is documented as the right answer in production: the variable only
 * exists to make a first sync faster by starting just before the deploy block.
 * A wrong value costs a longer scan, not a wrong index. It is still reported,
 * because a variable that is ignored silently is one nobody ever corrects.
 */
export function parseFromBlock(raw: string | undefined): {
  value: bigint | undefined
  problem: string | null
} {
  const v = (raw ?? '').trim()
  if (v.length === 0) return { value: undefined, problem: null }
  if (!/^[0-9]+$/.test(v)) {
    return {
      value: undefined,
      problem:
        `MOTIF_FROM_BLOCK is not a block number: ${JSON.stringify(v)}. ` +
        'Ignoring it and starting from the default window instead.',
    }
  }
  return { value: BigInt(v), problem: null }
}

/**
 * The rpc caps a log query at 10,000 results, and a wide window on this chain
 * blows straight past it. Small windows are slower but they never silently
 * return a truncated page, which would leave a permanent hole in the index.
 */
const WINDOW = 5_000n
const POLL_MS = 4_000

/**
 * How far back to re-scan on every pass.
 *
 * There is no reorg handling beyond this. Every write is keyed on the log, so
 * re-reading a range is harmless and cheap, and re-reading the tip means a
 * block that was reorganised out and replaced gets picked up again rather than
 * leaving a permanent hole. It does not remove a log that vanished, which is
 * the honest limit: an orphaned buy would linger. On an Arbitrum Orbit chain
 * with a centralised sequencer that is rare, and the alternative is tracking
 * block hashes per row, which is real work for a risk this shape.
 */
const REORG_LOOKBACK = 60n

const indexCreated = parseAbiItem(
  'event IndexCreated(uint256 indexed id, address indexed creator, uint16 creatorFeeBps, uint256 legs, string name, string symbol, string description, string image)',
)

/**
 * The same event as it was before a motif could carry a picture.
 *
 * Adding a field to an event changes its topic0 rather than lengthening its
 * payload, so `getLogs` filtered on the shape above matches none of the
 * launches on a router deployed before it. That is not a transitional
 * inconvenience: it is the router that is live, so scanning only the new shape
 * gives a healthy api that indexes nothing and a site with an empty grid, which
 * is the failure this file already has a gotcha about further up. Both are
 * scanned, the old one has no image, and the insert already reads that as ''.
 */
const indexCreatedNoImage = parseAbiItem(
  'event IndexCreated(uint256 indexed id, address indexed creator, uint16 creatorFeeBps, uint256 legs, string name, string symbol, string description)',
)
const bought = parseAbiItem(
  'event Bought(uint256 indexed id, address indexed buyer, uint256 amountIn, uint256 creatorFee, uint256 protocolFee)',
)
const sold = parseAbiItem(
  'event Sold(uint256 indexed id, address indexed seller, uint256 legs, uint256 amountOut)',
)
const rebalanced = parseAbiItem(
  'event Rebalanced(address indexed holder, uint256 indexed indexId, uint256 driftBefore)',
)
const subscribed = parseAbiItem(
  'event Subscribed(address indexed holder, uint256 indexed indexId, uint16 driftBps)',
)
const unsubscribed = parseAbiItem('event Unsubscribed(address indexed holder)')
const placed = parseAbiItem(
  'event Placed(uint256 indexed id, address indexed owner, address indexed token, uint8 kind, uint256 amount)',
)
const launched = parseAbiItem(
  'event Launched(address indexed curve, address indexed creator, uint256 indexed indexId, address vault, address pool, uint256 threshold, uint16 creatorFeeBps, uint256 legs, string name, string symbol, string description, string image)',
)
const curveStateAbi = [
  { type: 'function', name: 'raised', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'graduated', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const
const totalSupplyAbi = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const

const cancelled = parseAbiItem('event Cancelled(uint256 indexed id)')
const filled = parseAbiItem(
  'event Filled(uint256 indexed id, uint256 amountIn, uint256 amountOut, uint256 price18)',
)

const orderStateAbi = [
  {
    type: 'function',
    name: 'get',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'owner', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'kind', type: 'uint8' },
          { name: 'buying', type: 'bool' },
          { name: 'amount', type: 'uint256' },
          { name: 'filled', type: 'uint256' },
          { name: 'trigger', type: 'uint256' },
          { name: 'trailBps', type: 'uint16' },
          { name: 'peak', type: 'uint256' },
          { name: 'maxSlippageBps', type: 'uint16' },
          { name: 'slices', type: 'uint32' },
          { name: 'interval', type: 'uint32' },
          { name: 'lastFillAt', type: 'uint64' },
          { name: 'expiry', type: 'uint64' },
          { name: 'active', type: 'bool' },
        ],
      },
    ],
  },
] as const

const legsOfAbi = [
  {
    type: 'function',
    name: 'legsOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'weightBps', type: 'uint16' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'inputOf',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ type: 'address' }],
  },
] as const

export type Event =
  | { kind: 'index'; id: number; creator: string; name: string; symbol: string; block: number }
  | { kind: 'buy'; id: number; buyer: string; amountIn: string; block: number }
  | { kind: 'sell'; id: number; seller: string; amountOut: string; block: number }
  | { kind: 'rebalance'; holder: string; id: number; driftBefore: number; block: number }
  | { kind: 'curve'; curve: string; name: string; symbol: string; creator: string; block: number }

/** This chain returns blockTimestamp on the log itself. Fall back to zero
 *  rather than guessing, so the UI can tell "unknown" from "just now". */
const tsOf = (log: { blockTimestamp?: unknown }): number => {
  const raw = log.blockTimestamp
  if (typeof raw === 'string') return Number(BigInt(raw))
  if (typeof raw === 'bigint') return Number(raw)
  if (typeof raw === 'number') return raw
  return 0
}

export class Indexer {
  readonly client: PublicClient
  private timer: NodeJS.Timeout | null = null
  /** Where a fresh index should begin, remembered until the cursor is placed. */
  private startFrom: bigint | undefined
  private running = false
  /** Set on the last failure, cleared on the next success. The status page
   *  reports this rather than pretending a stalled indexer is healthy. */
  lastError: string | null = null
  lastRunAt = 0
  /** A misconfiguration that makes indexing pointless. Nothing is scanned. */
  readonly configError: string | null
  /** A variable that was wrong but recoverable, and what was done instead. */
  configWarning: string | null = null
  /** When the moving half of the curve rows was last refreshed. */
  private curvesRefreshedAt = 0
  /** True while a refresh is running, so a slow one is not started twice. */
  private refreshing = false

  constructor(
    private db: DB,
    private onEvent: (e: Event) => void,
  ) {
    this.client = createPublicClient({ transport: http(RPC) }) as PublicClient
    const problems = configProblems()
    this.configError = problems.length > 0 ? problems.join('; ') : null
  }

  get cursor(): number {
    const row = this.db.get('SELECT last_block FROM cursor WHERE id = 1') as
      | { last_block: number }
      | undefined
    return row?.last_block ?? 0
  }

  private setCursor(block: number) {
    this.db.run('UPDATE cursor SET last_block = ?, updated_at = ? WHERE id = 1', [block, Date.now()])
  }

  /**
   * @dev Never throws. An unreachable rpc used to take the whole process down
   *      here, which meant a blip at deploy time restart looped the service and
   *      took every route with it, including the ones that read only SQLite and
   *      need no chain at all. The api's job when the chain is unreachable is to
   *      stay up and say so, which is what `/v1/status` is for.
   *
   *      When the cursor cannot be placed, it is left unset and the next pass
   *      tries again. `run` is already safe to retry, because nothing is
   *      committed past the cursor.
   */
  async start(fromBlock?: bigint) {
    // Pointing at an address that is not one cannot be retried into working,
    // so this does not scan and does not poll. It is reported and left alone,
    // which keeps every route that reads only SQLite serving as normal.
    if (this.configError !== null) {
      this.lastError = this.configError
      console.error(`[indexer] ${this.configError}`)
      console.error('[indexer] not indexing. The api is up, and /v1/status reports this as not ok.')
      return
    }
    this.startFrom = fromBlock
    await this.placeCursor()
    const tick = () => {
      this.run().finally(() => {
        this.timer = setTimeout(tick, POLL_MS)
      })
    }
    tick()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Put the cursor somewhere sensible, once.
   *
   * Separate from `start` because it can fail, and a failure must not be fatal.
   * Until it succeeds the cursor stays at zero and `run` refuses to scan, which
   * is the point: a cursor of zero means "not placed yet", and treating it as
   * "start from genesis" would page six million empty blocks the moment the rpc
   * came back.
   */
  private async placeCursor(): Promise<boolean> {
    if (this.cursor !== 0) return true
    try {
      const head = await this.client.getBlockNumber()
      // A recent window rather than genesis. Nothing was deployed before this,
      // and scanning six million empty blocks helps nobody.
      const start = this.startFrom ?? (head > 200_000n ? head - 200_000n : 0n)
      this.setCursor(Number(start))
      this.lastError = null
      return true
    } catch (e) {
      this.lastError = `cannot reach the rpc to place the cursor: ${(e as Error).message}`
      return false
    }
  }

  /** One pass. Safe to call again if it throws: nothing is committed past the
   *  cursor, so a failed window is simply retried. */
  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      // Nothing to scan until the cursor has a home.
      if (!(await this.placeCursor())) return
      const head = await this.client.getBlockNumber()
      // Step back over the tip so a reorganised block is re-read rather than
      // silently skipped. Re-reading is free: the writes are idempotent.
      const cursor = BigInt(this.cursor)
      let from = cursor > REORG_LOOKBACK ? cursor - REORG_LOOKBACK : 0n
      // Writes are idempotent so re-reading is free, but the live feed is not:
      // without this the ticker would replay the same buys every four seconds.
      const emitAbove = cursor
      while (from <= head) {
        const to = from + WINDOW - 1n > head ? head : from + WINDOW - 1n
        await this.scan(from, to, emitAbove)
        this.setCursor(Number(to))
        from = to + 1n
      }
      // Started rather than awaited. It is a progress bar, not the chain, and
      // it is paced: with two hundred open curves it takes the better part of a
      // minute, and a pass that waited for it would stop following the chain
      // for that long every time. `refreshing` is what stops two overlapping.
      if (!this.refreshing) {
        this.refreshing = true
        void this.refreshCurves().finally(() => {
          this.refreshing = false
        })
      }
      this.lastError = null
      this.lastRunAt = Date.now()
    } catch (e) {
      this.lastError = (e as Error).message
    } finally {
      this.running = false
    }
  }

  /**
   * Re-read the half of a curve's state that moves.
   *
   * @remarks Throttled well below the indexing poll. This is three calls per
   * curve against an rpc that answers 429 under ordinary load, and a progress
   * bar does not need to be four seconds fresh. A curve that has graduated is
   * skipped entirely: nothing about it can change again, so polling it forever
   * would be spending the rate limit on a settled number.
   */
  private async refreshCurves(): Promise<void> {
    if (!hasFactory()) return
    if (Date.now() - this.curvesRefreshedAt < CURVE_REFRESH_MS) return
    this.curvesRefreshedAt = Date.now()

    const rows = this.db.all(
      'SELECT curve, vault FROM curves WHERE graduated = 0 ORDER BY block DESC LIMIT 200',
    ) as { curve: string; vault: string }[]

    for (const row of rows) {
      const curve = row.curve as `0x${string}`
      try {
        // Paced per curve rather than per call. This used to be a Promise.all
        // inside a loop over as many as two hundred curves, so six hundred
        // reads left at once, at an endpoint that refuses a burst and has no
        // paid tier to escape to. Three at a time is not a burst; six hundred
        // is. The gate is the one the keeper's reads go through, because there
        // is one endpoint and separate pacers would only arrive together.
        await chainPace.next()
        const [raised, sold, graduated] = await Promise.all([
          this.client.readContract({ address: curve, abi: curveStateAbi, functionName: 'raised' }),
          this.client.readContract({ address: curve, abi: curveStateAbi, functionName: 'sold' }),
          this.client.readContract({ address: curve, abi: curveStateAbi, functionName: 'graduated' }),
        ])
        // Supply only exists once the vault has minted, and reading it before
        // that is a real call for a guaranteed zero.
        let supply = 0n
        if (graduated) {
          await chainPace.next()
          supply = (await this.client.readContract({
            address: row.vault as `0x${string}`,
            abi: totalSupplyAbi,
            functionName: 'totalSupply',
          })) as bigint
        }
        this.db.run(
          'UPDATE curves SET raised = ?, sold = ?, supply = ?, graduated = ?, state_at = ? WHERE curve = ?',
          [String(raised), String(sold), String(supply), graduated ? 1 : 0, Math.floor(Date.now() / 1000), curve],
        )
      } catch {
        // One unreadable curve must not stop the others or fail the pass. The
        // row keeps its last good numbers and `state_at` stops advancing, which
        // is what tells the site the figure is stale rather than current.
      }
    }
  }

  private async scan(from: bigint, to: bigint, emitAbove: bigint) {
    const [created, buys, sells, rebals, subs, unsubs, placedLogs, cancelledLogs, filledLogs] =
      await Promise.all([
        Promise.all([
          this.client.getLogs({ address: ROUTER, event: indexCreated, fromBlock: from, toBlock: to }),
          this.client.getLogs({
            address: ROUTER,
            event: indexCreatedNoImage,
            fromBlock: from,
            toBlock: to,
          }),
        ]).then(([withImage, without]) => [
          ...withImage,
          // Given the field the older shape does not have, so everything below
          // reads one row shape rather than asking which router it came from.
          ...without.map((l) => ({ ...l, args: { ...l.args, image: '' } })),
        ]),
        this.client.getLogs({ address: ROUTER, event: bought, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: ROUTER, event: sold, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: REBALANCER, event: rebalanced, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: REBALANCER, event: subscribed, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: REBALANCER, event: unsubscribed, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: ORDERS, event: placed, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: ORDERS, event: cancelled, fromBlock: from, toBlock: to }),
        this.client.getLogs({ address: ORDERS, event: filled, fromBlock: from, toBlock: to }),
      ])

    // A launch is one row and it never changes, so it is written from the log
    // alone. The event deliberately carries the name, symbol, vault and pool so
    // this needs no call back into the chain, unlike an index's legs.
    if (hasFactory()) {
      const launches = await this.client.getLogs({
        address: FACTORY as `0x${string}`,
        event: launched,
        fromBlock: from,
        toBlock: to,
      })
      for (const log of launches) {
        this.db.run(
          `INSERT OR REPLACE INTO curves
             (curve, index_id, creator, vault, pool, threshold, creator_fee_bps, leg_count,
              name, symbol, description, image, block, tx, ts,
              raised, sold, supply, graduated, state_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   COALESCE((SELECT raised    FROM curves WHERE curve = ?), '0'),
                   COALESCE((SELECT sold      FROM curves WHERE curve = ?), '0'),
                   COALESCE((SELECT supply    FROM curves WHERE curve = ?), '0'),
                   COALESCE((SELECT graduated FROM curves WHERE curve = ?), 0),
                            (SELECT state_at  FROM curves WHERE curve = ?))`,
          [
            log.args.curve!.toLowerCase(),
            Number(log.args.indexId!),
            log.args.creator!.toLowerCase(),
            log.args.vault!.toLowerCase(),
            log.args.pool!.toLowerCase(),
            String(log.args.threshold!),
            Number(log.args.creatorFeeBps!),
            Number(log.args.legs!),
            log.args.name ?? '',
            log.args.symbol ?? '',
            log.args.description ?? '',
            // The chain is the record for this. Nothing in the api can change a
            // basket's picture, and re-indexing from zero reproduces it.
            log.args.image ?? '',
            Number(log.blockNumber),
            log.transactionHash!,
            tsOf(log as never),
            // The re-scan of the last sixty blocks replays a launch it has
            // already seen, and this row is the only one that carries state
            // written from somewhere else. Without carrying it across, every
            // pass would reset a live raise to zero for up to twenty seconds.
            log.args.curve!.toLowerCase(),
            log.args.curve!.toLowerCase(),
            log.args.curve!.toLowerCase(),
            log.args.curve!.toLowerCase(),
            log.args.curve!.toLowerCase(),
          ],
        )
        // Same guard as every other stream event here. The last sixty blocks
        // are re-scanned every pass to catch a reorg, so without this a launch
        // announces itself to every connected browser once a pass for a minute
        // after it happened.
        if (log.blockNumber! > emitAbove) {
          this.onEvent({
            kind: 'curve',
            curve: log.args.curve!.toLowerCase(),
            name: log.args.name ?? '',
            symbol: log.args.symbol ?? '',
            creator: log.args.creator!.toLowerCase(),
            block: Number(log.blockNumber),
          })
        }
      }
    }

    for (const log of created) {
      const id = Number(log.args.id!)
      // Legs are not in the event, because putting a dynamic array in a log
      // costs more than reading it back when one is actually needed.
      const [legs, input] = await Promise.all([
        this.client.readContract({
          address: ROUTER,
          abi: legsOfAbi,
          functionName: 'legsOf',
          args: [BigInt(id)],
        }),
        this.client.readContract({
          address: ROUTER,
          abi: legsOfAbi,
          functionName: 'inputOf',
          args: [BigInt(id)],
        }),
      ])

      this.db.run(
        `INSERT OR REPLACE INTO indexes
           (id, creator, creator_fee_bps, input, leg_count, block, tx, name, symbol, description, image, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          log.args.creator!.toLowerCase(),
          Number(log.args.creatorFeeBps!),
          (input as string).toLowerCase(),
          legs.length,
          Number(log.blockNumber),
          log.transactionHash!,
          log.args.name ?? '',
          log.args.symbol ?? '',
          log.args.description ?? '',
          // Absent on a launch read off the older event shape, and on anything
          // a curve published: a basket token has its own picture in the
          // factory's own log and nothing to pass here.
          log.args.image ?? '',
          tsOf(log as never),
        ],
      )
      legs.forEach((leg, i) => {
        this.db.run(
          `INSERT OR REPLACE INTO legs (index_id, position, token, fee, weight_bps)
           VALUES (?, ?, ?, ?, ?)`,
          [id, i, leg.token.toLowerCase(), Number(leg.fee), Number(leg.weightBps)],
        )
      })
      if (log.blockNumber! > emitAbove) this.onEvent({
        kind: 'index',
        id,
        creator: log.args.creator!.toLowerCase(),
        name: log.args.name ?? '',
        symbol: log.args.symbol ?? '',
        block: Number(log.blockNumber),
      })
    }

    for (const log of buys) {
      this.db.run(
        `INSERT OR IGNORE INTO buys
           (tx, log_index, index_id, buyer, amount_in, creator_fee, protocol_fee, block, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.transactionHash!,
          log.logIndex!,
          Number(log.args.id!),
          log.args.buyer!.toLowerCase(),
          log.args.amountIn!.toString(),
          log.args.creatorFee!.toString(),
          log.args.protocolFee!.toString(),
          Number(log.blockNumber),
          tsOf(log as never),
        ],
      )
      if (log.blockNumber! > emitAbove) this.onEvent({
        kind: 'buy',
        id: Number(log.args.id!),
        buyer: log.args.buyer!.toLowerCase(),
        amountIn: log.args.amountIn!.toString(),
        block: Number(log.blockNumber),
      })
    }

    for (const log of sells) {
      this.db.run(
        `INSERT OR IGNORE INTO sells
           (tx, log_index, index_id, seller, legs, amount_out, block, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          log.transactionHash!,
          log.logIndex!,
          Number(log.args.id!),
          log.args.seller!.toLowerCase(),
          Number(log.args.legs!),
          log.args.amountOut!.toString(),
          Number(log.blockNumber),
          tsOf(log as never),
        ],
      )
      if (log.blockNumber! > emitAbove) this.onEvent({
        kind: 'sell',
        id: Number(log.args.id!),
        seller: log.args.seller!.toLowerCase(),
        amountOut: log.args.amountOut!.toString(),
        block: Number(log.blockNumber),
      })
    }

    // The keeper's work list. Orders and subscriptions are tracked by their
    // current state rather than as an event log, because what a keeper needs to
    // know is simply which ones are still open.
    for (const log of placedLogs) {
      this.db.run(
        `INSERT OR REPLACE INTO orders (id, owner, token, kind, amount, active, block, ts)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          Number(log.args.id!),
          log.args.owner!.toLowerCase(),
          log.args.token!.toLowerCase(),
          Number(log.args.kind!),
          log.args.amount!.toString(),
          Number(log.blockNumber),
          tsOf(log as never),
        ],
      )
    }
    for (const log of cancelledLogs) {
      this.db.run('UPDATE orders SET active = 0 WHERE id = ?', [Number(log.args.id!)])
    }
    for (const log of filledLogs) {
      // A fill does not necessarily close an order, because a TWAP has more
      // slices to go, so the contract is asked rather than guessed at. Without
      // this a fully filled order stays on the keeper's work list forever and
      // the open count is a lie.
      const id = Number(log.args.id!)
      let stillActive = true
      try {
        const o = (await this.client.readContract({
          address: ORDERS,
          abi: orderStateAbi,
          functionName: 'get',
          args: [BigInt(id)],
        })) as { active: boolean }
        stillActive = o.active
      } catch {
        // Leave it open rather than closing something we could not read.
      }
      this.db.run('UPDATE orders SET block = ?, active = ? WHERE id = ?', [
        Number(log.blockNumber),
        stillActive ? 1 : 0,
        id,
      ])
    }
    for (const log of subs) {
      this.db.run(
        `INSERT OR REPLACE INTO subscriptions (holder, index_id, drift_bps, active, block, ts)
         VALUES (?, ?, ?, 1, ?, ?)`,
        [
          log.args.holder!.toLowerCase(),
          Number(log.args.indexId!),
          Number(log.args.driftBps!),
          Number(log.blockNumber),
          tsOf(log as never),
        ],
      )
    }
    for (const log of unsubs) {
      this.db.run('UPDATE subscriptions SET active = 0 WHERE holder = ?', [
        log.args.holder!.toLowerCase(),
      ])
    }

    for (const log of rebals) {
      this.db.run(
        `INSERT OR IGNORE INTO rebalances
           (tx, log_index, holder, index_id, drift_before, block, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          log.transactionHash!,
          log.logIndex!,
          log.args.holder!.toLowerCase(),
          Number(log.args.indexId!),
          Number(log.args.driftBefore!),
          Number(log.blockNumber),
          tsOf(log as never),
        ],
      )
      if (log.blockNumber! > emitAbove) this.onEvent({
        kind: 'rebalance',
        holder: log.args.holder!.toLowerCase(),
        id: Number(log.args.indexId!),
        driftBefore: Number(log.args.driftBefore!),
        block: Number(log.blockNumber),
      })
    }
  }
}

export const config = { RPC, ROUTER, REBALANCER, ORDERS, WINDOW: Number(WINDOW), POLL_MS }
