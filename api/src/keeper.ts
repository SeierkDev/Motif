import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { DB } from './db.js'
import { burnerAddress, config } from './indexer.js'
import { chainPace, isRefusal } from './rpc.js'

const ordersAbi = parseAbi([
  'function ready(uint256 id) view returns (bool ok, string why, uint256 price18)',
  'function execute(uint256 id)',
])
const rebalancerAbi = parseAbi([
  'function shouldRebalance(address holder) view returns (bool ok, string why)',
  'function rebalance(address holder)',
])
const burnerAbi = parseAbi([
  'function ready() view returns (bool ok, uint256 amount, string why)',
  'function burn(uint256 minMotifOut) returns (uint256 bought)',
])

const SWEEP_MS = Number(process.env.MOTIF_KEEPER_MS ?? 20_000)
/** Never spend more than this on one attempt, whatever the chain says. */
const GAS_CAP = BigInt(process.env.MOTIF_KEEPER_GAS_CAP ?? 3_000_000)
/** Stop after this many failures in a row rather than burning gas on a loop. */
const FAILURE_LIMIT = 5

/**
 * How often the burner is asked whether there is enough to burn. Five minutes
 * rather than every sweep: a burn is not time critical, the ten dollar minimum
 * takes ten thousand dollars of volume to fill, and every ask is one more read
 * against the only public rpc this chain has.
 */
const BURN_EVERY_MS = Number(process.env.MOTIF_BURN_MS ?? 300_000)

/**
 * How far under the simulated purchase the real one may land. The simulation
 * and the send are seconds apart and a fifty dollar purchase is too small to be
 * worth anybody's sandwich, measured in test/Burner.t.sol, so this only has to
 * absorb honest trades that land in between.
 */
const BURN_SLIPPAGE_BPS = 300n

/**
 * How far the sweep backs off when the endpoint refuses, and how far it will
 * go. It doubles from the normal interval, caps at five minutes, and resets the
 * moment a read gets through. A refusal is a reason to ask less often; it is
 * not a reason to stop, which is what happens if a 429 is allowed to count
 * toward the failure limit.
 */
const BACKOFF_CAP_MS = Number(process.env.MOTIF_KEEPER_BACKOFF_CAP_MS ?? 300_000)

type Row = { id?: number; holder?: string }

/** What a well formed key looks like: 0x and exactly 64 hex digits. */
const KEY_RE = /^0x[0-9a-fA-F]{64}$/

/**
 * The characters a mangled key is actually likely to contain, so the log can
 * name the culprit. Anything outside this list is reported as "not hex" and
 * never echoed: an unrecognised character could be part of whatever secret was
 * pasted in by mistake, and logs get shipped somewhere.
 */
const NAMED: Record<string, string> = {
  '"': 'a double quote',
  "'": 'a single quote',
  ' ': 'a space',
  '\n': 'a newline',
  '\r': 'a carriage return',
  '\t': 'a tab',
  '=': 'an equals sign',
  '$': 'a dollar sign',
  ',': 'a comma',
  ';': 'a semicolon',
  ':': 'a colon',
}

export type KeyResult =
  | { key: `0x${string}`; note: string | null }
  | { key: null; problem: string }

/** Describe the shape of a value that is not a key, without quoting the value. */
function describe(v: string): string {
  if (v.length === 0) return 'is empty once trimmed'

  const hadPrefix = /^0[xX]/.test(v)
  const body = hadPrefix ? v.slice(2) : v
  const stray = [...new Set(body.replace(/[0-9a-fA-F]/g, ''))]

  if (stray.length > 0) {
    const named = stray.filter((c) => c in NAMED).map((c) => NAMED[c])
    const rest = stray.length - named.length
    if (rest > 0) {
      const plural = rest === 1 ? 'character that is' : 'characters that are'
      named.push(`${rest} other ${plural} not hex`)
    }
    return `contains ${named.join(' and ')}, so the variable is holding more than the key`
  }

  return hadPrefix
    ? `is ${body.length} hex digits after the 0x, and a key is exactly 64`
    : `is ${body.length} hex digits with no 0x prefix, and a key is exactly 64`
}

/**
 * Read MOTIF_KEEPER_KEY and say precisely what is wrong with it.
 *
 * viem reports every malformed key with the same sentence, "invalid private
 * key, expected hex or 32 bytes, got string", whether the value lost its 0x,
 * is still wrapped in the quotes somebody typed into a dashboard, or is
 * truncated. That one line was the whole diagnosis available when the
 * container would not start, which is why this checks the shape itself and
 * names the actual fault.
 *
 * The two repairs are the two ways a pasted variable arrives mangled, and both
 * are unambiguous: a quoted key is not also something else, and 64 hex digits
 * are a key whether or not the 0x survived the trip. Anything else is refused
 * rather than guessed at, and a repair is logged so the variable gets fixed
 * instead of staying wrong and working by luck.
 */
export function parseKeeperKey(raw: string): KeyResult {
  let v = raw.trim()
  const notes: string[] = []

  // Quotes belong in a shell, not in a variable set through a web form, but
  // both Railway and Render store exactly what was pasted.
  const quoted =
    v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))
  if (quoted) {
    v = v.slice(1, -1).trim()
    notes.push('the surrounding quotes were stripped')
  }

  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    v = `0x${v}`
    notes.push('the missing 0x prefix was added')
  }

  if (!KEY_RE.test(v)) return { key: null, problem: describe(v) }

  // Correctly shaped is not the same as usable: zero and anything at or past
  // the group order are 32 bytes of hex and still not a key. viem is the
  // authority on that, so let it be the one that decides.
  try {
    privateKeyToAccount(v as `0x${string}`)
  } catch {
    // Not viem's message. Its wording for an out of range scalar quotes the
    // rejected number in full, which is the key itself in decimal, and this
    // string goes to the log and to /v1/status.
    return {
      key: null,
      problem:
        'is 32 bytes of hex but not a usable secp256k1 key: it has to be at ' +
        'least 1 and below the curve order',
    }
  }

  return { key: v as `0x${string}`, note: notes.length > 0 ? notes.join(', and ') : null }
}

/**
 * @title Keeper
 * @notice The thing that actually fires the orders.
 *
 * Everything on chain is permissionless, which I described as a virtue: anyone
 * may keep, so the service does not stop when one machine dies. What that
 * missed is that **nobody was keeping at all**. A stop loss placed before this
 * existed would sit there forever, including on the Sunday it was built for,
 * because `execute` is a transaction and no transaction was ever sent.
 *
 * Deliberate properties:
 *
 * - **It refuses to run without a usable key.** No silent half-working state:
 *   a missing key and a rejected one are separate states and `/v1/status`
 *   names both. What it does not do is take the process down over one, which
 *   it used to: that turned a mistyped variable into a service that never
 *   bound a port and a deploy that failed as a healthcheck timeout.
 * - **It simulates before it sends.** `ready` and `shouldRebalance` are cheap
 *   views and a revert costs gas, so nothing is submitted that the contract has
 *   already said no to.
 * - **It stops after repeated failure.** A keeper that retries a doomed call
 *   every twenty seconds is an expensive way to do nothing.
 * - **It records what it did.** A stalled keeper that looks healthy is worse
 *   than one that is obviously down, so every attempt lands in `keeper_log`
 *   and the status endpoint reports it.
 */
export class Keeper {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private failures = 0
  /**
   * How long to wait before the next sweep. Normally SWEEP_MS, doubled on a
   * refusal, and reset by the first read that gets through.
   */
  private nextSweepMs = SWEEP_MS
  /** When the endpoint last refused, so status can say so rather than imply health. */
  private refusedAt = 0
  private refusals = 0

  readonly enabled: boolean
  readonly address: Address | null = null
  /**
   * Why a key that was set got refused, or null when there was nothing wrong
   * with it. Distinct from no key at all: one is a service not configured to
   * keep, the other is one that was meant to keep and cannot.
   */
  readonly keyError: string | null = null
  private wallet: WalletClient | null = null
  private readonly reader: PublicClient

  lastSweepAt = 0
  fired = 0
  stopped: string | null = null

  /**
   * The burn half, kept apart from orders on purpose. A burn that keeps
   * failing, because the curve graduated or the fee wallet revoked its
   * approval, is no reason to stop firing somebody's stop loss, and one shared
   * failure count would have made it one.
   */
  private burnNextAt = 0
  private burnFailures = 0
  burnStopped: string | null = null
  burnsSent = 0
  private burnCheckedAt = 0
  private burnState: { ok: boolean; amount: string; why: string } | null = null

  constructor(private db: DB) {
    const raw = (process.env.MOTIF_KEEPER_KEY ?? '').trim()
    this.reader = createPublicClient({ transport: http(config.RPC) }) as PublicClient

    if (raw.length === 0) {
      this.enabled = false
      return
    }

    const parsed = parseKeeperKey(raw)
    if (parsed.key === null) {
      // Deliberately not a throw, which is what this used to do.
      //
      // This constructor runs before the http server binds, so a malformed key
      // took the entire service down on boot: no /healthz to answer, the
      // platform healthcheck retrying for five minutes and then failing the
      // deploy, and one viem sentence in the log that is the same sentence for
      // every possible mistake. A keeper that cannot sign is a real outage and
      // is reported as one, loudly, but it is not a reason to stop serving
      // reads or to stop recording levels, and a level is the only state here
      // that cannot be rebuilt from the chain afterwards. A crash loop records
      // none of them. This is the same call already made for an unreachable
      // rpc, for the same reason.
      this.enabled = false
      this.keyError = `MOTIF_KEEPER_KEY ${parsed.problem}`
      // Said here rather than in start(), which does not run until the indexer
      // has finished its first pass. Against a slow or unreachable rpc that is
      // a long way into the boot for the one line that explains the problem.
      console.error(`[keeper] ${this.keyError}`)
      console.error('[keeper] nothing will fire: no stop, no limit, no rebalance.')
      console.error('[keeper] the rest of the api is up, and /v1/status reports this as not ok.')
      return
    }

    if (parsed.note !== null) {
      console.warn(`[keeper] MOTIF_KEEPER_KEY was accepted, but ${parsed.note}. Fix the variable.`)
    }
    const account = privateKeyToAccount(parsed.key)
    this.address = account.address
    this.wallet = createWalletClient({ account, transport: http(config.RPC) })
    this.enabled = true
  }

  start() {
    // A refused key was already reported in full at the point it was refused.
    if (this.keyError !== null) return
    if (!this.enabled) {
      console.log('[keeper] no MOTIF_KEEPER_KEY set, orders will not fire and fees will not be burned')
      return
    }
    console.log(`[keeper] running as ${this.address}`)
    const burner = burnerAddress()
    if (burner !== null) console.log(`[keeper] burning protocol fees through ${burner}`)
    const tick = () => {
      this.sweep().finally(() => {
        this.timer = setTimeout(tick, this.nextSweepMs)
      })
    }
    tick()
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private log(kind: string, target: string, ok: boolean, tx: string | null, detail: string) {
    this.db.run(
      'INSERT INTO keeper_log (at, kind, target, tx, ok, detail) VALUES (?, ?, ?, ?, ?, ?)',
      [Date.now(), kind, target, tx, ok ? 1 : 0, detail.slice(0, 400)],
    )
  }

  async sweep(): Promise<void> {
    if (this.running || !this.enabled) return
    // Each half has its own stop, so the sweep only has nothing to do when
    // both have given up. Returning on `stopped` alone, as this used to, would
    // have let a stopped order keeper silently stop the burn with it.
    if (this.stopped && (this.burnStopped || burnerAddress() === null)) return
    this.running = true
    try {
      if (!this.stopped) {
        const orders = this.db.all('SELECT id FROM orders WHERE active = 1 ORDER BY id') as Row[]
        for (const row of orders) await this.tryOrder(row.id!)

        const subs = this.db.all('SELECT holder FROM subscriptions WHERE active = 1') as Row[]
        for (const row of subs) await this.tryRebalance(row.holder!)

        // Only the order half moves this. It is what `secondsSinceSweep`
        // reports, and a stopped keeper must not look like it is still sweeping.
        this.lastSweepAt = Date.now()
      }

      await this.tryBurn()
    } finally {
      this.running = false
    }
  }

  private async tryOrder(id: number) {
    let ok = false
    let why = ''
    try {
      await chainPace.next()
      const r = (await this.reader.readContract({
        address: config.ORDERS as Address,
        abi: ordersAbi,
        functionName: 'ready',
        args: [BigInt(id)],
      })) as [boolean, string, bigint]
      this.gotThrough()
      ok = r[0]
      why = r[1]
    } catch (e) {
      // Two different things arrive here and they used to be treated as one.
      //
      // The contract refusing is not a keeper problem and never was: `ready`
      // reverting means this order is not fillable, and the next sweep asks
      // again. The endpoint refusing is a different thing entirely, and
      // swallowing that silently is how a keeper sits there looking healthy
      // while every read it makes is being turned away.
      this.onRefusal(e)
      return
    }
    if (!ok) return

    try {
      const hash = await this.wallet!.writeContract({
        address: config.ORDERS as Address,
        abi: ordersAbi,
        functionName: 'execute',
        args: [BigInt(id)],
        chain: null,
        account: this.wallet!.account!,
        gas: GAS_CAP,
      })
      // viem does not throw on a reverted transaction, it hands back a receipt
      // that says so. Without this check the keeper reported every failure as a
      // fill and would have looked perfectly healthy while doing nothing.
      const receipt = await this.reader.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        this.onFailure('order', String(id), new Error(`reverted on chain in ${hash}`))
        return
      }
      this.fired++
      this.failures = 0
      this.log('order', String(id), true, hash, why || 'filled')
      console.log(`[keeper] filled order ${id} in ${hash}`)
    } catch (e) {
      this.onFailure('order', String(id), e as Error)
    }
  }

  private async tryRebalance(holder: string) {
    let ok = false
    try {
      await chainPace.next()
      const r = (await this.reader.readContract({
        address: config.REBALANCER as Address,
        abi: rebalancerAbi,
        functionName: 'shouldRebalance',
        args: [holder as Address],
      })) as [boolean, string]
      this.gotThrough()
      ok = r[0]
    } catch (e) {
      this.onRefusal(e)
      return
    }
    if (!ok) return

    try {
      const hash = await this.wallet!.writeContract({
        address: config.REBALANCER as Address,
        abi: rebalancerAbi,
        functionName: 'rebalance',
        args: [holder as Address],
        chain: null,
        account: this.wallet!.account!,
        gas: GAS_CAP,
      })
      const receipt = await this.reader.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        this.onFailure('rebalance', holder, new Error(`reverted on chain in ${hash}`))
        return
      }
      this.fired++
      this.failures = 0
      this.log('rebalance', holder, true, hash, 'rebalanced')
      console.log(`[keeper] rebalanced ${holder} in ${hash}`)
    } catch (e) {
      this.onFailure('rebalance', holder, e as Error)
    }
  }

  /**
   * Burn the protocol fee once there is enough of it.
   *
   * Asks the contract first, because `ready` is a free view and says why not,
   * then simulates the burn for the one number worth protecting: what this
   * exact state would buy. The send carries that less the slippage allowance as
   * its floor, so the purchase cannot land far under what was just quoted.
   */
  private async tryBurn() {
    const burner = burnerAddress() as Address | null
    if (burner === null || this.burnStopped) return
    if (Date.now() < this.burnNextAt) return
    this.burnNextAt = Date.now() + BURN_EVERY_MS

    let ok = false
    try {
      await chainPace.next()
      const [ready, amount, why] = (await this.reader.readContract({
        address: burner,
        abi: burnerAbi,
        functionName: 'ready',
      })) as [boolean, bigint, string]
      this.gotThrough()
      this.burnCheckedAt = Date.now()
      this.burnState = { ok: ready, amount: amount.toString(), why }
      ok = ready
    } catch (e) {
      // A refusal is the endpoint, and backs off like every other read.
      // Anything else is the burner itself not answering, which is almost
      // always MOTIF_BURNER pointing at something that is not a burner. Said
      // in status rather than swallowed: otherwise no burn would ever happen
      // and nothing anywhere would say why.
      if (isRefusal(e)) {
        this.onRefusal(e)
      } else {
        this.burnCheckedAt = Date.now()
        const detail = (e as Error).message?.split('\n')[0] ?? 'failed'
        this.burnState = { ok: false, amount: '0', why: `could not read the burner: ${detail}` }
      }
      return
    }
    if (!ok) return

    try {
      await chainPace.next()
      const sim = await this.reader.simulateContract({
        address: burner,
        abi: burnerAbi,
        functionName: 'burn',
        args: [0n],
        account: this.address!,
      })
      const floor = (sim.result * (10_000n - BURN_SLIPPAGE_BPS)) / 10_000n
      const hash = await this.wallet!.writeContract({
        address: burner,
        abi: burnerAbi,
        functionName: 'burn',
        args: [floor],
        chain: null,
        account: this.wallet!.account!,
        gas: GAS_CAP,
      })
      const receipt = await this.reader.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        this.onBurnFailure(new Error(`reverted on chain in ${hash}`))
        return
      }
      this.burnsSent++
      this.burnFailures = 0
      // Asked again on the next sweep rather than in five minutes, so a backlog
      // above the fifty dollar ceiling drains one burn per sweep.
      this.burnNextAt = 0
      const dollars = (Number(this.burnState?.amount ?? 0) / 1e6).toFixed(2)
      this.log('burn', burner, true, hash, `burned ${dollars} USDG of protocol fees`)
      console.log(`[keeper] burned ${dollars} USDG of protocol fees in ${hash}`)
    } catch (e) {
      this.onBurnFailure(e as Error)
    }
  }

  /** The same shape as `onFailure`, against the burn's own count and stop. */
  private onBurnFailure(e: Error) {
    const burner = burnerAddress() ?? 'burner'
    if (isRefusal(e)) {
      this.onRefusal(e)
      this.log('burn', burner, false, null, 'the rpc refused the send, backing off')
      return
    }
    const detail = e.message.split('\n')[0] ?? 'failed'
    this.burnFailures++
    this.log('burn', burner, false, null, detail)
    console.error(`[keeper] burn failed: ${detail}`)
    if (this.burnFailures >= FAILURE_LIMIT) {
      this.burnStopped = `stopped after ${this.burnFailures} consecutive failures: ${detail}`
      console.error(`[keeper] burning has ${this.burnStopped}`)
    }
  }

  /** A read got through, so whatever the endpoint was doing, it has stopped. */
  private gotThrough() {
    if (this.nextSweepMs !== SWEEP_MS) {
      console.log(`[keeper] the rpc is answering again, back to a sweep every ${SWEEP_MS / 1000}s`)
      this.nextSweepMs = SWEEP_MS
    }
  }

  /**
   * The endpoint refusing, handled as its own thing: ask less often, and say so.
   *
   * Deliberately not a failure. The failure count exists to stop a keeper
   * burning gas on a call the chain keeps rejecting, and a 429 is not the chain
   * rejecting anything, it is the chain not being asked. Counting one would
   * stop a healthy keeper permanently over a busy minute on the only rpc this
   * chain has, and it would need a hand to start again.
   *
   * Anything that is not a refusal passes straight through, so a read that
   * throws for a real reason is still nothing to do with the sweep interval.
   */
  private onRefusal(e: unknown) {
    if (!isRefusal(e)) return
    this.refusals++
    this.refusedAt = Date.now()
    const was = this.nextSweepMs
    this.nextSweepMs = Math.min(this.nextSweepMs * 2, BACKOFF_CAP_MS)
    if (this.nextSweepMs !== was) {
      const now = this.nextSweepMs / 1000
      console.warn(`[keeper] the rpc refused a read. Sweeping every ${now}s, was ${was / 1000}s.`)
    }
  }

  /**
   * Repeated failure is a reason to stop, not to try harder. Whatever is wrong,
   * a gas price the wallet cannot meet or a contract that has been paused, it
   * will not be fixed by another attempt in twenty seconds.
   *
   * Except the endpoint refusing, which is not a failure of the call at all and
   * is answered by backing off instead. That is the difference between a keeper
   * that rides out a busy minute and one that needs a human afterwards.
   */
  private onFailure(kind: string, target: string, e: Error) {
    if (isRefusal(e)) {
      this.onRefusal(e)
      this.log(kind, target, false, null, 'the rpc refused the send, backing off')
      return
    }
    const detail = e.message.split('\n')[0] ?? 'failed'
    this.failures++
    this.log(kind, target, false, null, detail)
    console.error(`[keeper] ${kind} ${target} failed: ${detail}`)
    if (this.failures >= FAILURE_LIMIT) {
      this.stopped = `stopped after ${this.failures} consecutive failures: ${detail}`
      console.error(`[keeper] ${this.stopped}`)
    }
  }

  /** Cleared by hand once whatever broke has been dealt with. */
  resume() {
    this.stopped = null
    this.failures = 0
    this.nextSweepMs = SWEEP_MS
    this.burnStopped = null
    this.burnFailures = 0
    this.burnNextAt = 0
  }

  status() {
    const recent = this.db.all(
      'SELECT at, kind, target, ok, detail, tx FROM keeper_log ORDER BY at DESC LIMIT 10',
    )
    const open = (this.db.get('SELECT COUNT(*) AS n FROM orders WHERE active = 1') as { n: number })
      .n
    const subs = (
      this.db.get('SELECT COUNT(*) AS n FROM subscriptions WHERE active = 1') as { n: number }
    ).n
    return {
      enabled: this.enabled,
      address: this.address,
      // Named honestly: a keeper with no key is not "running", and one that has
      // given up is not "healthy" just because the process is alive.
      state: this.keyError
        ? 'bad key'
        : !this.enabled
          ? 'no key'
          : this.stopped
            ? 'stopped'
            : this.nextSweepMs !== SWEEP_MS
              ? 'throttled'
              : 'running',
      keyError: this.keyError,
      stoppedReason: this.stopped,
      // Reported separately from stopped, because they are opposite situations.
      // A throttled keeper is working and asking less often; a stopped one has
      // given up and will not come back without a hand. Reporting a keeper the
      // rpc is refusing as simply healthy is how "it needs a paid rpc" turns
      // into something nobody can check.
      throttle: {
        sweepEverySeconds: Math.round(this.nextSweepMs / 1000),
        refusals: this.refusals,
        lastRefusedAt: this.refusedAt || null,
      },
      fired: this.fired,
      lastSweepAt: this.lastSweepAt || null,
      secondsSinceSweep: this.lastSweepAt
        ? Math.round((Date.now() - this.lastSweepAt) / 1000)
        : null,
      watching: { openOrders: open, subscriptions: subs },
      recent,
      // Its own block and its own state, because a stopped burn is not a
      // stopped keeper and must never read as one, in either direction.
      burn: {
        burner: burnerAddress(),
        state:
          burnerAddress() === null
            ? 'no burner'
            : !this.enabled
              ? 'no key'
              : this.burnStopped
                ? 'stopped'
                : 'watching',
        stoppedReason: this.burnStopped,
        lastCheckAt: this.burnCheckedAt || null,
        ready: this.burnState?.ok ?? null,
        // USDG in six decimals, as a decimal string like every amount here.
        availableUsdg: this.burnState?.amount ?? null,
        why: this.burnState?.why ?? null,
        sent: this.burnsSent,
      },
    }
  }
}
