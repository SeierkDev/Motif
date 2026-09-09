'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { formatUnits, parseAbi, parseUnits, type Abi } from 'viem'
import { addresses, basketCurveAbi, basketVaultAbi, basketRouterAbi, tokenSwapAbi, swapAddress, symbolOf, colorOf } from '@/lib/contracts'
import { API, price as priceLabel, short } from '@/lib/api'
import { PriceChart, type PricePoint } from './LevelChart'
import { floorFrom, quoteLeg } from '@/lib/quote'

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

type State = {
  name: string
  symbol: string
  vault: `0x${string}`
  pool: `0x${string}`
  threshold: bigint
  raised: bigint
  sold: bigint
  curveSupply: bigint
  graduated: boolean
  usdgReserve: bigint
  tokenReserve: bigint
  lpBps: number
  creator: `0x${string}`
  legs: `0x${string}`[]
  /** The index's published weights, so the band is sized by what it targets. */
  weights: { token: `0x${string}`; weightBps: number; fee: number }[]
  // Per wallet, all zero when nobody is connected.
  unclaimed: bigint
  tokenBalance: bigint
  totalSupply: bigint
  usdgBalance: bigint
}

const TOLERANCES = [50, 100, 300]

/**
 * The fee tier `BasketCurve` opens a basket token's own pool at.
 *
 * @dev A constant of the contract rather than something to look up. 0.3% is the
 *      tier the volatile stock pools on this chain already use, and a basket of
 *      equities is not a stablecoin pair.
 */
const LP_FEE = 3000

/**
 * Tolerances offered on graduation, which is a different trade to a curve buy.
 * It fills every leg at once against real pools and moves them as it goes, so
 * the tightest bound that makes sense here is wider than the widest that makes
 * sense there.
 */
const GRAD_TOLERANCES = [300, 500, 1000]

/** The most the router can take off a buy: a 1% creator fee plus the 0.1% protocol fee. */
const MAX_FEE_BPS = 110

/**
 * The curve's own price, in USDG's six decimals per whole token.
 *
 * @dev **Only meaningful before graduation.** `usdgReserve` and `tokenReserve`
 *      are pure functions of `raised` and `sold`, and both of those are frozen
 *      the moment `graduate` runs, so after that this returns the price the
 *      curve closed at and never moves again. It was the headline number on a
 *      graduated page, sitting directly above a chart of the live pool price
 *      that disagreed with it. See `headlinePrice`.
 */
const priceOf = (s: State) => (s.tokenReserve === 0n ? 0n : (s.usdgReserve * 10n ** 18n) / s.tokenReserve)

/**
 * What the token costs right now, whichever side of graduation it is on.
 *
 * @dev Before graduation, the curve. After it, the newest reading the api has
 *      of the token's own pool, because that is where it actually trades and
 *      the curve stopped being a price. With no reading yet it falls back to
 *      the closing price rather than showing nothing, and says which it is.
 */
function headlinePrice(s: State, history: PricePoint[] | null): { usd18: bigint; live: boolean } {
  // `priceOf` is usdg's own six decimals per whole token; the api quotes a
  // price at eighteen. Carried at eighteen here so the label has every digit
  // to work with rather than a number already rounded to a millionth.
  if (!s.graduated) return { usd18: priceOf(s) * 10n ** 12n, live: true }
  const latest = history?.[0]
  if (latest) return { usd18: BigInt(latest.price18), live: true }
  return { usd18: priceOf(s) * 10n ** 12n, live: false }
}

/** A dollar price from an 1e18 fixed point, with as many digits as it needs. */
const usd18 = (v: bigint) => priceLabel(Number(v) / 1e18)

const fmtUsdg = (v: bigint, dp = 2) =>
  Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })

const fmtToken = (v: bigint) =>
  Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })

/**
 * The contract address, as the thing people actually do with it.
 *
 * @dev It was a line of dim 11px text under the name, which at 390 wrapped
 *      across two lines and is below what anybody can select with a thumb.
 *      Copying it is the only reason it is on the page, so it is a button.
 */
function CopyAddress({ address }: { address: `0x${string}` }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`copy${done ? ' done' : ''}`}
      onClick={() => {
        navigator.clipboard?.writeText(address).then(
          () => {
            setDone(true)
            setTimeout(() => setDone(false), 1600)
          },
          () => {},
        )
      }}
      title={address}
    >
      {short(address)}
      <span>{done ? 'copied' : 'copy'}</span>
    </button>
  )
}

/**
 * A basket token, before and after it exists.
 *
 * One page with two states rather than two pages, because it is one thing: the
 * curve is how the token gets sold and the vault is what it turns into, and a
 * holder who leaves and comes back should find the same url whichever side of
 * graduation they land on.
 */
export function CurvePage({ curve }: { curve: `0x${string}` }) {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [s, setS] = useState<State | null>(null)
  const [notFound, setNotFound] = useState(false)
  /**
   * Whether this page has ever read successfully.
   *
   * @dev The reload below runs every twelve seconds against a public rpc that
   *      rate limits, and any throw in it used to land in the same catch as a
   *      bad address. So one 429 turned a page somebody was reading into
   *      "Nothing here", which is a much stronger claim than "could not read
   *      just now". Once it has loaded, a later failure leaves the last good
   *      state on screen and waits for the next pass.
   */
  const everLoaded = useRef(false)

  /**
   * The creator's own picture, which is the one thing on this page that is not
   * on the chain in a form a call can read.
   *
   * @dev It rides in the launch log rather than in storage, because a picture
   *      has no business in the redemption arithmetic and putting a string in
   *      storage costs every launcher money for something no contract ever
   *      reads. So the api is asked for it, separately and after the fact: if
   *      it is unreachable, or has not indexed this launch yet, the page draws
   *      the basket's weights instead and nothing else about it changes.
   */
  const [image, setImage] = useState<string | null>(null)
  /** Dropped the moment the picture fails to load, for the reason in `Tokens`. */
  const [imageBroken, setImageBroken] = useState(false)

  /**
   * Price and floor over time, from the api rather than the chain.
   *
   * @dev A price that has already gone cannot be re-read, so nothing here can
   *      derive this: it exists only because the api has been recording it on
   *      a timer since the launch. An unreachable api means no chart, and the
   *      rest of the page still works off the chain as it always did.
   */
  const [history, setHistory] = useState<PricePoint[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!client) return
    try {
      const read = (functionName: string, args: unknown[] = []) =>
        client.readContract({ address: curve, abi: basketCurveAbi, functionName, args })

      const [vault, pool, threshold, raised, sold, curveSupply, graduated, usdgReserve, tokenReserve, lpBps, router, indexId, creator] =
        (await Promise.all([
          read('vault'), read('pool'), read('threshold'), read('raised'), read('sold'),
          read('CURVE_SUPPLY'), read('graduated'), read('usdgReserve'), read('tokenReserve'), read('LP_BPS'),
          read('router'), read('indexId'), read('creator'),
        ])) as [
          `0x${string}`, `0x${string}`, bigint, bigint, bigint, bigint, boolean, bigint, bigint, number,
          `0x${string}`, bigint, `0x${string}`,
        ]

      const v = (functionName: string, args: unknown[] = []) =>
        client.readContract({ address: vault, abi: basketVaultAbi, functionName, args })

      const [name, symbol, legs, totalSupply] = (await Promise.all([
        v('name'), v('symbol'), v('legs'), v('totalSupply'),
      ])) as [string, string, `0x${string}`[], bigint]

      // Weights come from the index the curve buys at, not from the vault. The
      // vault only knows which tokens it holds, and rendering those as equal
      // bands would draw a 60/40 basket as 50/50.
      let weights: { token: `0x${string}`; weightBps: number; fee: number }[] = []
      try {
        const published = (await client.readContract({
          address: router, abi: basketRouterAbi, functionName: 'legsOf', args: [indexId],
        })) as { token: `0x${string}`; weightBps: number; fee: number }[]
        weights = published.map((l) => ({
          token: l.token,
          weightBps: Number(l.weightBps),
          fee: Number(l.fee),
        }))
      } catch {
        // An unreadable router must not take the page down with it. Without
        // weights the band is dropped rather than drawn wrong.
        weights = []
      }

      let unclaimed = 0n
      let tokenBalance = 0n
      let usdgBalance = 0n
      if (address) {
        ;[unclaimed, tokenBalance, usdgBalance] = (await Promise.all([
          read('balanceOf', [address]),
          v('balanceOf', [address]),
          client.readContract({ address: addresses.usdg, abi: erc20, functionName: 'balanceOf', args: [address] }),
        ])) as [bigint, bigint, bigint]
      }

      setS({
        name, symbol, vault, pool, threshold, raised, sold, curveSupply, graduated,
        usdgReserve, tokenReserve, lpBps: Number(lpBps), creator, legs, weights,
        unclaimed, tokenBalance, totalSupply, usdgBalance,
      })
      everLoaded.current = true
      setNotFound(false)
    } catch {
      // A wrong address, or a chain that has never heard of this contract. Both
      // are the same thing to a visitor and neither is an error worth a stack.
      if (!everLoaded.current) setNotFound(true)
    }
  }, [client, curve, address])

  useEffect(() => {
    load()
    const t = setInterval(load, 12_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    let off = false
    fetch(`${API}/v1/curves/${curve}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => !off && setImage((b?.curve?.image as string | undefined) ?? null))
      .catch(() => {})
    return () => { off = true }
  }, [curve])

  useEffect(() => {
    let off = false
    const load = () =>
      fetch(`${API}/v1/curves/${curve}/history?limit=500`)
        .then((r) => (r.ok ? r.json() : null))
        .then((b) => !off && setHistory((b?.levels as PricePoint[] | undefined) ?? []))
        .catch(() => !off && setHistory([]))
    load()
    const t = setInterval(load, 60_000)
    return () => { off = true; clearInterval(t) }
  }, [curve])

  if (notFound) {
    return (
      <section className="view">
        <div className="wrap">
          <h1>Nothing here</h1>
        <p className="lede">
          No basket token lives at <span className="num" style={{ overflowWrap: 'anywhere' }}>{curve}</span>.
            Check the address, or that your wallet is on Robinhood Chain.
          </p>
        </div>
      </section>
    )
  }
  if (!s) {
    return (
      <section className="view">
        <div className="wrap"><p className="dim">Reading the chain...</p></div>
      </section>
    )
  }

  const progress = s.threshold === 0n ? 0 : Number((s.raised * 10_000n) / s.threshold) / 100
  const ready = s.raised >= s.threshold
  const price = headlinePrice(s, history)

  return (
    <section className="view">
      <div className="wrap">
      <div className="tokenhead">
        <div className="tokenhead-id">
          {image && !imageBroken && (
            <div className="tokenpic">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image} alt="" onError={() => setImageBroken(true)} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            {/* The ticker is its own line rather than trailing inside the
                heading. Inside it, a two word name wrapped to three lines on a
                phone and the ticker ended up alone on the last one. */}
            <h1 className="tokenhead-name">{s.name}</h1>
            <div className="tokenhead-sym">{s.symbol}</div>
            <CopyAddress address={curve} />
          </div>
        </div>
        <div className="tokenhead-price">
          <div className="side-label">
            {s.graduated ? (price.live ? 'In the pool' : 'Graduated') : 'On the curve'}
          </div>
          <div className="num">{usd18(price.usd18)}</div>
        </div>
      </div>

      {s.weights.length > 0 && (
        <div className="weights" style={{ marginTop: 18 }}>
          {s.weights.map((w) => (
            <div key={w.token} style={{ background: colorOf(w.token), width: `${w.weightBps / 100}%` }} />
          ))}
        </div>
      )}
      <div className="dim small" style={{ marginTop: 8 }}>
        Backed by{' '}
        {s.weights.length > 0
          ? s.weights.map((w) => `${symbolOf(w.token)} ${w.weightBps / 100}%`).join(', ')
          : s.legs.map(symbolOf).join(', ')}
      </div>

      {history !== null && (
        <div style={{ marginTop: 22 }}>
          <div className="side-label" style={{ marginBottom: 10 }}>
            {s.graduated ? 'Price, against what it redeems for' : 'Price along the curve'}
          </div>
          <PriceChart points={history} />
        </div>
      )}

      {!s.graduated ? (
        <Curve s={s} progress={progress} ready={ready} />
      ) : (
        <Graduated s={s} />
      )}

      {error && <div className="notice" style={{ marginTop: 16 }}>{error}</div>}
      {done && <div className="notice" style={{ marginTop: 16, borderLeftColor: 'var(--accent)' }}>{done}</div>}

      {isConnected ? (
        <Actions
          s={s}
          curve={curve}
          ready={ready}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          setDone={setDone}
          reload={load}
          writeContractAsync={writeContractAsync}
          client={client}
          address={address!}
        />
      ) : (
        <div className="notice" style={{ marginTop: 24 }}>Connect a wallet to buy, claim or redeem.</div>
      )}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------ the raise */

function Curve({ s, progress, ready }: { s: State; progress: number; ready: boolean }) {
  return (
    <>
      <div className="card" style={{ marginTop: 24 }}>
        <div className="row">
          <span className="side-label">Raised</span>
          <span className="num">
            ${fmtUsdg(s.raised)} <span className="dim">of ${fmtUsdg(s.threshold)}</span>
          </span>
        </div>
        <div
          style={{
            height: 8, borderRadius: 4, background: 'var(--line)', marginTop: 12, overflow: 'hidden',
          }}
        >
          <div style={{ width: `${Math.min(progress, 100)}%`, height: '100%', background: 'var(--accent)' }} />
        </div>
        <div className="dim small" style={{ marginTop: 10, lineHeight: 1.6 }}>
          {ready ? (
            <>
              The raise is complete. Anybody can graduate it now: {100 - s.lpBps / 100}% of the money buys the
              real stock into a vault, {s.lpBps / 100}% seeds a pool that nobody can withdraw, and the token
              becomes redeemable for its share of the stock.
            </>
          ) : (
            <>
              At ${fmtUsdg(s.threshold)} this graduates. {100 - s.lpBps / 100}% of the raise buys the real stock
              into a vault and {s.lpBps / 100}% seeds a pool whose liquidity nobody can ever pull back out.
              After that every token can be redeemed for its share of the stock. That redemption is the floor,
              and it sits at what the stock is worth rather than at what anybody paid. Until then you can sell
              back along the curve at any time.
            </>
          )}
        </div>
      </div>

      <div className="strip">
        <div><div className="k">Price</div><div className="v">{usd18(priceOf(s) * 10n ** 12n)}</div></div>
        <div><div className="k">Sold</div><div className="v">{fmtToken(s.sold)}</div></div>
        <div><div className="k">Curve supply</div><div className="v">{fmtToken(s.curveSupply)}</div></div>
        <div><div className="k">Progress</div><div className="v">{progress.toFixed(1)}%</div></div>
      </div>
    </>
  )
}

/* -------------------------------------------------------- after the fact */

function Graduated({ s }: { s: State }) {
  return (
    <>
      <div className="card" style={{ marginTop: 24 }}>
        <div className="row">
          <span className="side-label">Backing</span>
          <span className="dim small num">vault {short(s.vault)}</span>
        </div>
        <p className="dim small" style={{ marginTop: 10, lineHeight: 1.7 }}>
          The raise has been spent. Every token is redeemable, at any time, for its share of the real stock in
          the vault, and there is no pause, allowlist or fee on the way out. That is what stops the price
          sitting below the value of the stock: anyone who can buy it cheaper than the backing can buy it, burn
          it, take the stock and keep the difference.
        </p>
        <p className="dim small" style={{ marginTop: 10, lineHeight: 1.7 }}>
          <b>How far below the price that floor sits is the number to look at, and it is on the chart above.</b>{' '}
          A token opens trading several times its backing, on purpose, so that the first trade is not
          immediately underneath the floor. Anyone buying in the pool is buying above it, and the gap is
          theirs to lose.
        </p>
        <p className="dim small" style={{ marginTop: 10, lineHeight: 1.7 }}>
          The stock can still fall. The guarantee is that nobody can take the backing, which is a different
          sentence from &ldquo;you cannot lose money&rdquo;.
        </p>
      </div>

      <div className="strip">
        <div><div className="k">Supply</div><div className="v">{fmtToken(s.totalSupply)}</div></div>
        <div><div className="k">Your tokens</div><div className="v">{fmtToken(s.tokenBalance)}</div></div>
        <div><div className="k">Unclaimed</div><div className="v">{fmtToken(s.unclaimed)}</div></div>
        <div><div className="k">Legs</div><div className="v">{s.legs.length}</div></div>
      </div>
    </>
  )
}

/* --------------------------------------------------------------- actions */

type ActionProps = {
  s: State
  curve: `0x${string}`
  ready: boolean
  busy: string | null
  setBusy: (v: string | null) => void
  setError: (v: string | null) => void
  setDone: (v: string | null) => void
  reload: () => void
  writeContractAsync: ReturnType<typeof useWriteContract>['writeContractAsync']
  client: ReturnType<typeof usePublicClient>
  address: `0x${string}`
}

function Actions(p: ActionProps) {
  const { s, curve, ready, busy, setBusy, setError, setDone, reload, writeContractAsync, client, address } = p

  const [amount, setAmount] = useState('100')
  const [tolerance, setTolerance] = useState(100)
  const [quote, setQuote] = useState<bigint | null>(null)
  const [sellAmount, setSellAmount] = useState('')
  const [sellQuote, setSellQuote] = useState<bigint | null>(null)
  const [backing, setBacking] = useState<{ tokens: `0x${string}`[]; amounts: bigint[] } | null>(null)
  const [gradQuotes, setGradQuotes] = useState<bigint[] | null>(null)
  const [gradTolerance, setGradTolerance] = useState(500)

  const amountIn = (() => { try { return parseUnits(amount || '0', 6) } catch { return 0n } })()
  const tokensIn = (() => { try { return parseUnits(sellAmount || '0', 18) } catch { return 0n } })()

  // Quotes come off the curve itself rather than being recomputed here. The
  // arithmetic is deterministic but the state it reads against is not, and a
  // second implementation is a second thing to get wrong.
  useEffect(() => {
    let off = false
    if (!client || amountIn === 0n || s.graduated) { setQuote(null); return }
    client.readContract({ address: curve, abi: basketCurveAbi, functionName: 'quoteBuy', args: [amountIn] })
      .then((q) => !off && setQuote(q as bigint))
      .catch(() => !off && setQuote(null))
    return () => { off = true }
  }, [client, curve, amountIn, s.graduated, s.raised])

  useEffect(() => {
    let off = false
    if (!client || tokensIn === 0n || s.graduated) { setSellQuote(null); return }
    client.readContract({ address: curve, abi: basketCurveAbi, functionName: 'quoteSell', args: [tokensIn] })
      .then((q) => !off && setSellQuote(q as bigint))
      .catch(() => !off && setSellQuote(null))
    return () => { off = true }
  }, [client, curve, tokensIn, s.graduated, s.raised])

  useEffect(() => {
    let off = false
    if (!client || !s.graduated || s.tokenBalance === 0n) { setBacking(null); return }
    client.readContract({
      address: s.vault, abi: basketVaultAbi, functionName: 'backingOf', args: [s.tokenBalance],
    })
      .then((r) => {
        const [tokens, amounts] = r as [`0x${string}`[], bigint[]]
        if (!off) setBacking({ tokens, amounts })
      })
      .catch(() => !off && setBacking(null))
    return () => { off = true }
  }, [client, s.graduated, s.vault, s.tokenBalance])

  /**
   * What is left to sell on the curve, and the largest spend that fits in it.
   *
   * @dev `buy` reverts `SupplyExhausted` on a spend that would take more than
   *      the curve has left, and the control used to offer it anyway: near the
   *      end of a raise the quote was shown, the button was enabled, and the
   *      wallet prompt ended in a revert with nothing on the page to say why.
   *      The curve's own arithmetic gives the exact spend that lands on the
   *      last token, so it is offered as the Max instead.
   */
  const remaining = s.curveSupply > s.sold ? s.curveSupply - s.sold : 0n
  const floorReserve = s.tokenReserve > remaining ? s.tokenReserve - remaining : 0n
  const maxSpend = floorReserve === 0n ? 0n : (s.usdgReserve * remaining) / floorReserve
  const overSupply = quote !== null && quote > remaining

  /**
   * Per leg floors for graduation.
   *
   * @dev This button used to pass an array of zeroes, which graduates at any
   *      price at all. It is the largest single trade the system ever makes,
   *      every leg in one block against pools it moves as it goes, and it is
   *      permissionless, so the caller passing the bound is not always the
   *      person whose money is being spent. Quoted from the pools the same way
   *      an ordinary basket buy is, on the share of the raise that actually
   *      reaches the router: the pool tranche comes off first, then the fees.
   *      The fee side uses the highest a creator is allowed to charge, because
   *      the exact figure is not on the curve and guessing low here only ever
   *      loosens the floor.
   */
  useEffect(() => {
    let off = false
    if (!client || !ready || s.graduated || s.weights.length === 0) { setGradQuotes(null); return }

    const forStock = (s.raised * BigInt(10_000 - s.lpBps)) / 10_000n
    const afterFees = (forStock * BigInt(10_000 - MAX_FEE_BPS)) / 10_000n
    Promise.all(
      s.weights.map((l) => quoteLeg(client, l.token, l.fee, (afterFees * BigInt(l.weightBps)) / 10_000n)),
    )
      .then((q) => !off && setGradQuotes(q))
      .catch(() => !off && setGradQuotes(null))
    return () => { off = true }
  }, [client, ready, s.graduated, s.raised, s.lpBps, s.weights])

  /**
   * Run one transaction and say whether it landed.
   *
   * @dev The return value is the point. This used to be `void`, so a caller
   *      that ran an approval and then a spend carried on to the spend whatever
   *      happened to the approval: a rejected wallet prompt showed its error for
   *      an instant and was then replaced by the next one, which failed on an
   *      allowance the user had just declined to give. Two errors for one
   *      refusal, neither of them the real one.
   */
  async function run(label: string, fn: () => Promise<`0x${string}`>): Promise<boolean> {
    setError(null); setDone(null); setBusy(label)
    try {
      const hash = await fn()
      await client!.waitForTransactionReceipt({ hash })
      setDone(`${label} confirmed.`)
      reload()
      return true
    } catch (e) {
      setError((e as Error).message.split('\n')[0]!)
      return false
    } finally {
      setBusy(null)
    }
  }

  async function buy() {
    if (!client || quote === null) return
    const allowance = (await client.readContract({
      address: addresses.usdg, abi: erc20, functionName: 'allowance', args: [address, curve],
    })) as bigint
    if (allowance < amountIn) {
      const approved = await run('Approving USDG', () =>
        writeContractAsync({
          address: addresses.usdg, abi: erc20, functionName: 'approve', args: [curve, amountIn],
        }),
      )
      if (!approved) return
    }
    const minOut = (quote * BigInt(10_000 - tolerance)) / 10_000n
    await run('Buy', () =>
      writeContractAsync({
        address: curve, abi: basketCurveAbi, functionName: 'buy', args: [amountIn, minOut],
      }),
    )
  }

  if (!s.graduated) {
    return (
      <>
        <div className="card" style={{ marginTop: 24 }}>
          <div className="side-label" style={{ marginBottom: 12 }}>Buy on the curve</div>
          <div className="buybar">
            <div>
              <label>Spend USDG</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label>Slippage</label>
              <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
                {TOLERANCES.map((t) => <option key={t} value={t}>{t / 100}%</option>)}
              </select>
            </div>
            <button
              className="btn"
              disabled={!!busy || quote === null || amountIn === 0n || overSupply}
              onClick={buy}
            >
              {busy ?? 'Buy'}
            </button>
          </div>
          <div className="dim small" style={{ marginTop: 12 }}>
            {overSupply ? (
              <>
                Only <b className="num">{fmtToken(remaining)}</b> {s.symbol} is left on the curve, which is
                about <b className="num">${fmtUsdg(maxSpend)}</b>.{' '}
                <a
                  href="#"
                  onClick={(e) => { e.preventDefault(); setAmount(formatUnits(maxSpend, 6)) }}
                >
                  Use that
                </a>
                .
              </>
            ) : quote === null ? (
              'Enter an amount.'
            ) : (
              <>You get about <b className="num">{fmtToken(quote)}</b> {s.symbol}. Wallet holds ${fmtUsdg(s.usdgBalance)}.</>
            )}
          </div>
        </div>

        {s.unclaimed > 0n && (
          <div className="card">
            <div className="side-label" style={{ marginBottom: 12 }}>Sell back</div>
            <div className="buybar">
              <div>
                <label>{s.symbol} to sell</label>
                <input value={sellAmount} onChange={(e) => setSellAmount(e.target.value)} inputMode="decimal" />
              </div>
              <button
                className="btn ghost"
                onClick={() => setSellAmount(formatUnits(s.unclaimed, 18))}
              >
                Max
              </button>
              <button
                className="btn ghost"
                disabled={!!busy || tokensIn === 0n || sellQuote === null}
                onClick={() =>
                  run('Sell', () =>
                    writeContractAsync({
                      address: curve, abi: basketCurveAbi, functionName: 'sell',
                      args: [tokensIn, (sellQuote! * BigInt(10_000 - tolerance)) / 10_000n],
                    }),
                  )
                }
              >
                Sell
              </button>
            </div>
            <div className="dim small" style={{ marginTop: 12 }}>
              You hold <b className="num">{fmtToken(s.unclaimed)}</b> {s.symbol} on the curve
              {sellQuote !== null && <> and would get back <b className="num">${fmtUsdg(sellQuote)}</b></>}.
              Selling is only possible before graduation, because afterwards the money has been spent on stock.
            </div>
          </div>
        )}

        {ready && (
          <div className="card">
            <div className="side-label" style={{ marginBottom: 12 }}>Graduate</div>
            <p className="dim small" style={{ marginBottom: 14, lineHeight: 1.7 }}>
              The threshold is met, so anybody can trigger this and nobody is paid for doing it. It buys the
              basket, puts it in the vault, seeds the pool and mints the token, all in one transaction. If any
              leg cannot fill it reverts whole and the curve stays open.
            </p>
            <div className="buybar">
              <div>
                <label>Slippage per leg</label>
                <select value={gradTolerance} onChange={(e) => setGradTolerance(Number(e.target.value))}>
                  {GRAD_TOLERANCES.map((t) => <option key={t} value={t}>{t / 100}%</option>)}
                </select>
              </div>
              <button
                className="btn"
                disabled={!!busy || gradQuotes === null}
                onClick={() =>
                  run('Graduate', () =>
                    writeContractAsync({
                      address: curve, abi: basketCurveAbi, functionName: 'graduate',
                      args: [gradQuotes!.map((q) => floorFrom(q, gradTolerance))],
                    }),
                  )
                }
              >
                {busy ?? 'Graduate this basket'}
              </button>
            </div>
            <div className="dim small" style={{ marginTop: 12 }}>
              {gradQuotes === null
                ? 'Reading the leg prices. Graduating without them would mean buying at any price at all.'
                : <>Every leg has to fill within {gradTolerance / 100}% of its pool price or the whole
                  graduation reverts and the curve stays open.</>}
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {s.unclaimed > 0n && (
        <div className="card" style={{ marginTop: 24 }}>
          <div className="side-label" style={{ marginBottom: 12 }}>Claim</div>
          <p className="dim small" style={{ marginBottom: 14 }}>
            You bought <b className="num">{fmtToken(s.unclaimed)}</b> {s.symbol} on the curve. The token exists
            now, so take delivery of it.
          </p>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              run('Claim', () =>
                writeContractAsync({ address: curve, abi: basketCurveAbi, functionName: 'claim', args: [] }),
              )
            }
          >
            {busy ?? `Claim ${fmtToken(s.unclaimed)} ${s.symbol}`}
          </button>
        </div>
      )}

      {s.tokenBalance > 0n && (
        <div className="card" style={{ marginTop: s.unclaimed > 0n ? 12 : 24 }}>
          <div className="side-label" style={{ marginBottom: 12 }}>Redeem for the stock</div>
          {backing && (
            <div style={{ marginBottom: 14 }}>
              {backing.tokens.map((t, i) => (
                <div className="row small" key={t} style={{ padding: '6px 0' }}>
                  <span style={{ color: colorOf(t) }}>{symbolOf(t)}</span>
                  <span className="num">{Number(formatUnits(backing.amounts[i]!, 18)).toFixed(6)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="dim small" style={{ marginBottom: 14, lineHeight: 1.7 }}>
            Burns all <b className="num">{fmtToken(s.tokenBalance)}</b> {s.symbol} and sends you the stock
            above, straight to your wallet. No permission, no fee, no waiting.
          </p>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() =>
              run('Redeem', () =>
                writeContractAsync({
                  address: s.vault, abi: basketVaultAbi, functionName: 'redeem', args: [s.tokenBalance],
                }),
              )
            }
          >
            {busy ?? 'Redeem everything'}
          </button>
        </div>
      )}

      <TradePanel
        s={s}
        busy={busy}
        run={run}
        client={client}
        address={address}
        writeContractAsync={writeContractAsync}
      />

      <CollectFees
        s={s}
        curve={curve}
        busy={busy}
        run={run}
        client={client}
        writeContractAsync={writeContractAsync}
      />
    </>
  )
}

/**
 * Trading the token at its market price, which until this existed was not
 * something the site could offer at all.
 *
 * @dev **Why a contract was needed for a thing the pool already does.** A
 *      Uniswap V3 pool collects the input side by calling
 *      `uniswapV3SwapCallback` on whoever called `swap`, and a wallet is not a
 *      contract and has no code to answer with. So a pool cannot be traded
 *      directly from a browser, and without `TokenSwap` in front of it this page
 *      could price a token it could not let anybody trade. The only exit on
 *      offer was `redeem`, which pays the backing rather than the market, and a
 *      launchpad whose sell button is missing reads as one where selling is not
 *      allowed.
 *
 *      **Redemption is still here and still the one that never depends on
 *      anybody.** These two are different trades and the copy says which is
 *      which: the pool pays what the market says and can pay less than the
 *      backing if the market falls that far, redemption always pays the backing
 *      and needs no counterparty at all.
 *
 *      **The quote is a simulation of the exact call the button sends**, not an
 *      arithmetic estimate off `slot0`. A basket token's pool is thin by design,
 *      a fifth of the raise, so price impact on any real order is the number
 *      that matters and an estimate that ignores it would be wrong by the one
 *      thing worth knowing. Simulating runs the swap against current state and
 *      reports what actually comes out.
 */
function TradePanel({
  s,
  busy,
  run,
  client,
  address,
  writeContractAsync,
}: {
  s: State
  busy: string | null
  run: (label: string, fn: () => Promise<`0x${string}`>) => Promise<boolean>
  client: ReturnType<typeof usePublicClient>
  address: `0x${string}` | undefined
  writeContractAsync: ReturnType<typeof useWriteContract>['writeContractAsync']
}) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [amount, setAmount] = useState('')
  const [tolerance, setTolerance] = useState(100)
  const [quote, setQuote] = useState<bigint | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)

  const buying = side === 'buy'
  const tokenIn = buying ? addresses.usdg : s.vault
  const tokenOut = buying ? s.vault : addresses.usdg
  const held = buying ? s.usdgBalance : s.tokenBalance

  const amountIn = (() => {
    try {
      return parseUnits(amount || '0', buying ? 6 : 18)
    } catch {
      return 0n
    }
  })()

  /*
   * Simulated from the trader's own address, because that is the call that will
   * be sent and it is the only way the answer includes their balance and
   * allowance. Before an approval exists the simulation fails, which is not an
   * error worth showing: it means "approve first", and the button already says
   * so. Only a failure with an allowance in place is reported.
   */
  useEffect(() => {
    let off = false
    // Captured, because the narrowing does not survive into the callback below.
    const swap = swapAddress
    if (!client || amountIn === 0n || !swap) {
      setQuote(null)
      setQuoteError(null)
      return
    }
    const t = setTimeout(() => {
      client
        .simulateContract({
          address: swap,
          abi: tokenSwapAbi as Abi,
          functionName: 'swap',
          args: [tokenIn, tokenOut, LP_FEE, amountIn, 0n, BigInt(Math.floor(Date.now() / 1000) + 1800)],
          account: address ?? '0x0000000000000000000000000000000000000001',
        })
        .then((r) => {
          if (off) return
          setQuote(r.result as bigint)
          setQuoteError(null)
        })
        .catch(() => {
          if (off) return
          setQuote(null)
          setQuoteError('Cannot price this trade until the approval below is in place.')
        })
    }, 250)
    return () => {
      off = true
      clearTimeout(t)
    }
  }, [client, address, amountIn, tokenIn, tokenOut])

  if (!swapAddress) {
    return (
      <div className="card">
        <div className="side-label" style={{ marginBottom: 10 }}>Trade</div>
        <p className="dim small" style={{ lineHeight: 1.7 }}>
          {s.symbol} trades against USDG in its own Uniswap pool at{' '}
          <span className="num">{short(s.pool)}</span>, and no trading contract is deployed on this network
          yet, so there is no market button here rather than one that reverts. Redemption above is unaffected:
          it pays the backing, needs nobody&rsquo;s permission and cannot be turned off.
        </p>
      </div>
    )
  }

  const min = quote === null ? 0n : (quote * BigInt(10_000 - tolerance)) / 10_000n
  const over = amountIn > held

  async function trade() {
    const swap = swapAddress
    if (!client || !address || quote === null || !swap) return
    const allowance = (await client.readContract({
      address: tokenIn,
      abi: erc20,
      functionName: 'allowance',
      args: [address, swap],
    })) as bigint
    if (allowance < amountIn) {
      // The exact amount, so the allowance is consumed by the trade and nothing
      // is left standing against a contract afterwards. The same trade this
      // repo already makes on selling a motif, and the same friction.
      const approved = await run(`Approving ${buying ? 'USDG' : s.symbol}`, () =>
        writeContractAsync({
          address: tokenIn,
          abi: erc20,
          functionName: 'approve',
          args: [swap, amountIn],
        }),
      )
      if (!approved) return
    }
    await run(buying ? 'Buy' : 'Sell', () =>
      writeContractAsync({
        address: swap,
        abi: tokenSwapAbi as Abi,
        functionName: 'swap',
        args: [tokenIn, tokenOut, LP_FEE, amountIn, min, BigInt(Math.floor(Date.now() / 1000) + 1800)],
      }),
    )
    setAmount('')
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="side-label">Trade at the market</div>
        {/* The same tab control the rest of the site uses, rather than a new
            one. A second style of toggle is a second thing to keep consistent. */}
        <div className="tabs">
          <button
            className={`tab${buying ? ' on' : ''}`}
            onClick={() => { setSide('buy'); setAmount(''); setQuote(null) }}
          >
            Buy
          </button>
          <button
            className={`tab${buying ? '' : ' on'}`}
            onClick={() => { setSide('sell'); setAmount(''); setQuote(null) }}
          >
            Sell
          </button>
        </div>
      </div>

      <div className="buybar four">
        <div>
          <label>{buying ? 'Spend USDG' : `Sell ${s.symbol}`}</label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>
        <div>
          <label>Slippage</label>
          <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
            {TOLERANCES.map((t) => (
              <option key={t} value={t}>{t / 100}%</option>
            ))}
          </select>
        </div>
        <button
          className="btn ghost"
          onClick={() => setAmount(formatUnits(held, buying ? 6 : 18))}
        >
          Max
        </button>
        <button
          className="btn"
          disabled={!!busy || !address || amountIn === 0n || over || quote === null}
          onClick={trade}
        >
          {busy ?? (buying ? 'Buy' : 'Sell')}
        </button>
      </div>

      <div className="dim small" style={{ marginTop: 12, lineHeight: 1.7 }}>
        {!address ? (
          'Connect a wallet to trade.'
        ) : over ? (
          <>
            That is more than the <b className="num">
              {buying ? `$${fmtUsdg(s.usdgBalance)}` : `${fmtToken(s.tokenBalance)} ${s.symbol}`}
            </b>{' '}
            in your wallet.
          </>
        ) : amountIn === 0n ? (
          'Enter an amount.'
        ) : quote === null ? (
          quoteError ?? 'Pricing this against the pool...'
        ) : (
          <>
            You get about{' '}
            <b className="num">{buying ? `${fmtToken(quote)} ${s.symbol}` : `$${fmtUsdg(quote)}`}</b>, and the
            trade reverts below{' '}
            <b className="num">{buying ? `${fmtToken(min)} ${s.symbol}` : `$${fmtUsdg(min)}`}</b>. This is the
            pool&rsquo;s price, which can be under the backing if the market falls that far. Redeeming pays
            the backing instead and never depends on anybody.
          </>
        )}
      </div>

      <div className="dim small" style={{ marginTop: 12, lineHeight: 1.7 }}>
        The pool is <span className="num">{short(s.pool)}</span>. Its liquidity was seeded at graduation and
        the principal cannot be withdrawn by anyone, including whoever launched this. The 0.3% it charges on
        every trade goes to the creator, and taking that cannot touch the liquidity underneath.
      </div>
    </div>
  )
}

/**
 * The creator's ongoing revenue, and the only way to actually take it.
 *
 * @dev **This is the whole reason `collectFees` exists and there was no way to
 *      call it.** The router's creator fee is charged on the one buy a basket
 *      ever makes, so it is a few tens of dollars once; the pool's 0.3% is
 *      charged on every trade for the life of the token, and it was accruing to
 *      a position nobody could reach from a browser. A revenue model with no
 *      button is a revenue model nobody collects.
 *
 *      Shown to everybody rather than only to the creator, because the function
 *      is permissionless and always pays the creator whoever calls it. There is
 *      nothing in it for a stranger and nothing a stranger can take, so hiding
 *      it would only mean a creator without gas has no one who can do it for
 *      them.
 *
 *      The pending amount comes from simulating the call rather than from a
 *      view, because there is no view: fees are only moved into `tokensOwed`
 *      when the position is touched, which is what the `burn(0)` inside it is
 *      for. Simulating runs exactly the call the button sends and reports what
 *      it would return, which is the honest number rather than an estimate.
 */
function CollectFees({
  s,
  curve,
  busy,
  run,
  client,
  writeContractAsync,
}: {
  s: State
  curve: `0x${string}`
  busy: string | null
  run: (label: string, fn: () => Promise<`0x${string}`>) => Promise<boolean>
  client: ReturnType<typeof usePublicClient>
  writeContractAsync: ReturnType<typeof useWriteContract>['writeContractAsync']
}) {
  const [pending, setPending] = useState<{ usdg: bigint; token: bigint } | null>(null)

  useEffect(() => {
    let off = false
    if (!client) return
    const load = () =>
      client
        .simulateContract({ address: curve, abi: basketCurveAbi, functionName: 'collectFees' })
        .then((r) => {
          const [usdg, token] = r.result as [bigint, bigint]
          if (!off) setPending({ usdg, token })
        })
        .catch(() => !off && setPending(null))
    load()
    const t = setInterval(load, 30_000)
    return () => { off = true; clearInterval(t) }
  }, [client, curve])

  const nothing = pending !== null && pending.usdg === 0n && pending.token === 0n

  return (
    <div className="card">
      <div className="row">
        <span className="side-label">Creator fees</span>
        <span className="dim small num">to {short(s.creator)}</span>
      </div>

      {/* Two cells, so two columns. The strip is a four column grid, and two of
          them in it left half the card as empty panel. */}
      <div className="strip" style={{ marginTop: 14, gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div>
          <div className="k">Waiting, USDG</div>
          <div className="v">{pending ? `$${fmtUsdg(pending.usdg)}` : '—'}</div>
        </div>
        <div>
          <div className="k">Waiting, {s.symbol}</div>
          <div className="v">{pending ? fmtToken(pending.token) : '—'}</div>
        </div>
      </div>

      <p className="dim small" style={{ marginTop: 14, lineHeight: 1.7 }}>
        The pool takes 0.3% on every trade of {s.symbol} and it is paid to whoever launched this, for as long
        as the token exists. <b>Anybody can press this and it always pays the creator</b>, so a creator who is
        away does not stop it. None of it comes out of the raise or the backing: traders pay it per swap, as
        in any pool, and collecting cannot touch the liquidity underneath.
      </p>

      <button
        className="btn"
        disabled={!!busy || pending === null || nothing}
        onClick={() =>
          run('Collecting fees', () =>
            writeContractAsync({ address: curve, abi: basketCurveAbi, functionName: 'collectFees' }),
          )
        }
      >
        {busy ??
          (pending === null
            ? 'Reading what is owed'
            : nothing
              ? 'Nothing to collect yet'
              : 'Pay the creator')}
      </button>
    </div>
  )
}
