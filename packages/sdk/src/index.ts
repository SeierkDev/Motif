/**
 * The Motif SDK.
 *
 * Two halves that are deliberately kept apart. `MotifClient` reads the public
 * API, needs no key and no wallet, and is what most integrations want. The
 * contract helpers below build transactions but never send them, so signing
 * stays entirely with the caller's own wallet library.
 *
 *   npm i @motif/sdk
 *
 *   const motif = new MotifClient()
 *   const { indexes } = await motif.indexes()
 *   motif.stream((e) => console.log(e))
 */

export const DEFAULT_API = 'https://api.motif.fund'

export type Leg = { position: number; token: string; fee: number; weight_bps: number }

export type Index = {
  id: number
  creator: string
  creator_fee_bps: number
  input: string
  leg_count: number
  block: number
  tx: string
  legs: Leg[]
  /** Exact integer strings. Summed with BigInt rather than through a double,
   *  which loses the low bits above 2^53 on an 18 decimal quote asset. */
  volume?: string
  fees?: string
  holders?: number
  buys?: number
  performance?: Performance | null
}

/**
 * A basket token: an index sold on a curve, then backed by a vault.
 *
 * The static half comes from the launch's own log and can never change, because
 * none of it has a setter anywhere in the contracts. The moving half is polled,
 * and `stateAt` says when: **null means never read, which is not zero**, and a
 * client has to render it as unknown.
 */
export type Curve = {
  curve: string
  indexId: number
  creator: string
  vault: string
  pool: string
  name: string
  symbol: string
  description: string
  /** The creator's picture, from the launch log. Null when there was none. */
  image: string | null
  legCount: number
  legs: Leg[]
  creatorFeeBps: number
  /** Exact integer strings, in the quote asset's own decimals. */
  threshold: string
  raised: string
  sold: string
  supply: string
  graduated: boolean
  /** Integer basis points, so nothing rounds 99.99% up to done. */
  progressBps: number
  block: number
  tx: string
  ts: number
  stateAt: number | null
}

/**
 * One reading of what a basket token costs and what it redeems for.
 *
 * Both are USDG per whole token as decimal strings, 1e18. **`floor18` is null
 * for every reading taken before graduation**, because there was no vault
 * holding anything yet, and drawing that as zero would be a different claim.
 */
export type CurveLevel = { at: number; price18: string; floor18: string | null }

export type Buy = {
  tx: string
  log_index: number
  index_id: number
  buyer: string
  amount_in: string
  creator_fee: string
  protocol_fee: string
  block: number
}

export type Sell = {
  tx: string
  log_index: number
  index_id: number
  seller: string
  /** How many legs the sale covered. A partial exit touches fewer. */
  legs: number
  amount_out: string
  block: number
  ts: number
}

export type Rebalance = {
  tx: string
  log_index: number
  holder: string
  index_id: number
  drift_before: number
  block: number
}

export type Performance = {
  level: string | null
  since: number | null
  /** Basis points. **null means unknown**, not flat: a motif launched an hour
   *  ago has no 24 hour figure and pretending it is zero would be a lie. */
  changeBps: Record<string, number | null>
}

export type Order = {
  id: number
  owner: string
  token: string
  kind: number
  amount: string
  active: number
  block: number
  ts: number
}

export type Creator = {
  creator: string
  launched: number
  fees: string
  volume: string
  lastLaunchTs: number
}

/**
 * One burn of the protocol fee, off the burner's own `Burned` log.
 *
 * `motifBurned` can exceed `motifBought`: the contract burns everything it
 * holds, so MOTIF sent to it before a call is destroyed along with that call's
 * purchase. USDG is six decimals, ETH and MOTIF eighteen, all decimal strings.
 */
export type Burn = {
  tx: string
  logIndex: number
  caller: string
  usdgIn: string
  ethSpent: string
  motifBought: string
  motifBurned: string
  block: number
  ts: number
}

export type Burns = {
  /** Null when the api has no burner configured, which is not the same as none burned. */
  burner: string | null
  totals: { burns: number; usdgIn: string; motifBurned: string }
  burns: Burn[]
}

export type Stats = {
  indexes: number
  buys: number
  sells: number
  rebalances: number
  uniqueBuyers: number
  creators: number
  /** Decimal strings, not numbers. BigInt sums, and above 2^53 a double loses
   *  the low bits. Reported separately rather than netted: money in and money
   *  out are two facts, and one figure hides which moved. */
  volumeIn: string
  volumeOut: string
  /** The tokenised half. Zero when no factory is configured. */
  curves: number
  graduated: number
  raisedOnCurves: string
}

/**
 * Everything `/v1/status` actually reports.
 *
 * @dev This had drifted, and drifted in the direction that matters least
 *      visibly: the route grew a keeper block, a levels block, two config
 *      fields and two chain addresses, and this type kept describing the api
 *      from before any of them existed. A typed client could therefore not see
 *      the keeper's state, the level recorder's state, or a misconfiguration
 *      the api had already detected and was reporting, which are the three
 *      things this route exists for. Worse than untyped: it says those fields
 *      are not there.
 */
export type Status = {
  ok: boolean
  indexer: {
    lastBlock: number
    lastRunAt: number | null
    secondsSinceRun: number | null
    error: string | null
    /** A misconfiguration that makes indexing pointless. Nothing is scanned. */
    configError: string | null
    /** A variable that was wrong but recoverable, and what was done instead. */
    configWarning: string | null
  }
  keeper: {
    enabled: boolean
    address: string | null
    /**
     * Named honestly rather than as a boolean. A keeper with no key is not
     * "running", one that has given up is not healthy just because the process
     * is alive, and one the rpc is refusing is working and asking less often,
     * which is a different thing again from stopped.
     */
    state: 'bad key' | 'no key' | 'stopped' | 'throttled' | 'running'
    keyError: string | null
    stoppedReason: string | null
    /** How far the sweep has backed off while the rpc is refusing reads. */
    throttle: { sweepEverySeconds: number; refusals: number; lastRefusedAt: number | null }
    fired: number
    lastSweepAt: number | null
    secondsSinceSweep: number | null
    watching: { openOrders: number; subscriptions: number }
    recent: {
      at: number
      kind: string
      target: string
      ok: number
      detail: string
      tx: string | null
    }[]
    /**
     * The protocol fee burn, run from the same key on a slower timer. Kept out
     * of `state` above on purpose: a stopped burn is not a stopped keeper, and
     * neither may hold the other up.
     */
    burn: {
      burner: string | null
      state: 'no burner' | 'no key' | 'stopped' | 'watching'
      stoppedReason: string | null
      lastCheckAt: number | null
      ready: boolean | null
      /** USDG, six decimals, as a decimal string. */
      availableUsdg: string | null
      why: string | null
      sent: number
    }
  }
  /** The price recorder. The one piece of state here that cannot be rebuilt. */
  levels: {
    lastSweepAt: number | null
    secondsSinceSweep: number | null
    motifsPriced: number
    pointsRecorded: number
    curvePointsRecorded: number
    recordingSince: number | null
    error: string | null
  }
  /**
   * `factory` is null when none is configured, which is a fact rather than a
   * fault: nothing tokenised is deployed, so an empty `/v1/curves` has to be
   * distinguishable from a broken one.
   */
  chain: {
    rpc: string
    router: string
    rebalancer: string
    orders: string
    factory: string | null
    /** Null when none is configured: no burns are indexed or triggered. */
    burner: string | null
  }
  /**
   * What the data actually occupies, in bytes.
   *
   * @dev Read this rather than the hosting platform's volume graph. A Railway
   *      volume reserves 2 to 3% of its total for filesystem metadata and
   *      counts it as used, so growing one from 5GB to 100GB moved that graph
   *      by 1.5GB in four minutes with nothing being written. The gap between
   *      the two numbers is the filesystem, not the database.
   *
   *      `wal` is counted separately rather than folded into `main` on
   *      purpose: it grows between checkpoints and shrinks again, so a large
   *      `wal` against a small `main` is a checkpoint that has not happened
   *      rather than data, and a single total would make that look permanent.
   */
  storage: {
    /** `main` plus `wal`, which is what the file set occupies on disk. */
    total: number
    main: number
    /** The write ahead log and its shared memory file, together. */
    wal: number
    /** The picture store's share, the one part bounded by a variable. */
    images: number
  }
  migrations: string[]
  uptimeSeconds: number
  subscribers: number
}

export type StreamEvent =
  | { kind: 'hello'; lastBlock: number }
  | { kind: 'index'; id: number; creator: string; block: number }
  | { kind: 'buy'; id: number; buyer: string; amountIn: string; block: number }
  | { kind: 'sell'; id: number; seller: string; amountOut: string; block: number }
  | { kind: 'rebalance'; holder: string; id: number; driftBefore: number; block: number }
  | { kind: 'curve'; curve: string; name: string; symbol: string; creator: string; block: number }

export class MotifError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Seconds to wait, present on a 429. The api allows 240 a minute. */
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'MotifError'
  }
}

export class MotifClient {
  constructor(private readonly baseUrl: string = DEFAULT_API) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number }
      throw new MotifError(body.error ?? `HTTP ${res.status}`, res.status, body.retryAfter)
    }
    return (await res.json()) as T
  }

  indexes(limit = 50) {
    return this.get<{ indexes: Index[] }>(`/v1/indexes?limit=${limit}`)
  }

  /**
   * Ranked. `return` and `worst` sort on performance and drop motifs with no
   * reading yet, rather than sorting them as if they were flat.
   */
  leaderboard(by: 'volume' | 'fees' | 'buys' | 'new' | 'return' | 'worst' = 'return', limit = 50) {
    return this.get<{ by: string; indexes: Index[] }>(`/v1/leaderboard?by=${by}&limit=${limit}`)
  }

  /** Activity inside a window, so this morning's launch can outrank last month's. */
  trending(hours = 24, limit = 25) {
    return this.get<{ hours: number; indexes: Index[] }>(`/v1/trending?hours=${hours}&limit=${limit}`)
  }

  /** The recorded level series. This is the part nobody can backfill. */
  history(id: number, limit = 500) {
    return this.get<{ levels: { at: number; level18: string }[]; performance: Performance }>(
      `/v1/indexes/${id}/history?limit=${limit}`,
    )
  }

  creators(limit = 50) {
    return this.get<{ creators: Creator[] }>(`/v1/creators?limit=${limit}`)
  }

  creator(address: string) {
    return this.get<{ address: string; launched: number; feesEarned: string; indexes: Index[] }>(
      `/v1/creators/${address}`,
    )
  }

  /** Open orders, or every order belonging to one address. */
  orders(owner?: string) {
    return this.get<{ orders: Order[] }>(`/v1/orders${owner ? `?owner=${owner}` : ''}`)
  }

  index(id: number) {
    return this.get<Index>(`/v1/indexes/${id}`)
  }

  buysOf(id: number, limit = 50) {
    return this.get<{ buys: Buy[] }>(`/v1/indexes/${id}/buys?limit=${limit}`)
  }

  /**
   * Every basket token, newest first.
   *
   * Empty when the api has no factory configured, which is a fact rather than
   * a fault: `status().chain.factory` is null in that case, so an empty list is
   * distinguishable from an indexer that is quietly broken.
   */
  curves(limit = 60) {
    return this.get<{ curves: Curve[] }>(`/v1/curves?limit=${limit}`)
  }

  /** One basket token, by its curve address. */
  curve(address: string) {
    return this.get<{ curve: Curve }>(`/v1/curves/${address}`)
  }

  /**
   * Price and floor over time for one basket token, newest first.
   *
   * A price that has already gone cannot be re-read from the chain, so this is
   * only ever as complete as the api's own record of it.
   */
  curveHistory(address: string, limit = 500) {
    return this.get<{ levels: CurveLevel[] }>(`/v1/curves/${address}/history?limit=${limit}`)
  }

  /**
   * Exits, newest first. Keyset paged like `buys`.
   *
   * Separate from `buys` rather than signed amounts on one feed, because a sale
   * has no fees and can cover any subset of the legs. Netting the two would
   * hide which one moved.
   */
  sells(limit = 50, before?: string) {
    return this.get<{ sells: Sell[]; next: string | null }>(
      `/v1/sells?limit=${limit}${before ? `&before=${before}` : ''}`,
    )
  }

  /**
   * Keyset paged. Pass the previous response's `next` as `before` to continue.
   * Not an offset: on a live feed new buys land between pages and an offset
   * would silently skip or repeat rows.
   */
  buys(limit = 50, before?: string) {
    return this.get<{ buys: Buy[]; next: string | null }>(
      `/v1/buys?limit=${limit}${before ? `&before=${before}` : ''}`,
    )
  }

  rebalances(limit = 50) {
    return this.get<{ rebalances: Rebalance[] }>(`/v1/rebalances?limit=${limit}`)
  }

  holder(address: string) {
    return this.get<{ address: string; buys: Buy[]; rebalances: Rebalance[] }>(
      `/v1/holders/${address}`,
    )
  }

  stats() {
    return this.get<Stats>('/v1/stats')
  }

  /** Every burn of the protocol fee, newest first, with the totals. */
  burns(limit = 50) {
    return this.get<Burns>(`/v1/burns?limit=${limit}`)
  }

  status() {
    return this.get<Status>('/v1/status')
  }

  /**
   * Live events over a websocket.
   *
   * Reconnects on its own with a backoff, because the common failure here is a
   * laptop lid closing rather than a server going away, and an integration
   * that silently stops receiving is worse than one that errors.
   *
   * @returns a function that stops the stream and cancels any pending retry.
   */
  stream(onEvent: (e: StreamEvent) => void, onError?: (e: Error) => void): () => void {
    const url = this.baseUrl.replace(/^http/, 'ws') + '/v1/stream'
    let closed = false
    let attempt = 0
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      socket = new WebSocket(url)
      socket.onopen = () => {
        attempt = 0
      }
      socket.onmessage = (m) => {
        try {
          onEvent(JSON.parse(String(m.data)) as StreamEvent)
        } catch (e) {
          onError?.(e as Error)
        }
      }
      socket.onerror = () => onError?.(new Error('stream error'))
      socket.onclose = () => {
        if (closed) return
        const wait = Math.min(30_000, 500 * 2 ** attempt++)
        timer = setTimeout(connect, wait)
      }
    }
    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      socket?.close()
    }
  }
}

/* ---------------------------------------------------------------- contracts */

/**
 * Generated from the compiled artifacts by `npm run abi`, never written by
 * hand. The hand written version drifted the moment `createIndex` gained a
 * name and a ticker, so anybody launching through the SDK would have encoded a
 * call the contract no longer had.
 */
import { generated } from './abi.generated.js'

export const basketRouterAbi = generated.basketRouter
export const rebalancerAbi = generated.rebalancer
export const ordersAbi = generated.orders
export const basketCurveAbi = generated.basketCurve
export const basketVaultAbi = generated.basketVault
export const basketFactoryAbi = generated.basketFactory
export const tokenSwapAbi = generated.tokenSwap

export const chain = {
  mainnet: { id: 4663, rpc: 'https://rpc.mainnet.chain.robinhood.com' },
  testnet: { id: 46630, rpc: 'https://rpc.testnet.chain.robinhood.com' },
} as const

/** Turn a per leg estimate into the floor the contract will enforce. */
export const minOutFrom = (estimates: bigint[], toleranceBps: number): bigint[] =>
  estimates.map((e) => (e * BigInt(10_000 - toleranceBps)) / 10_000n)
