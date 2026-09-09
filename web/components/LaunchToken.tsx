'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { parseAbi, parseEventLogs, parseUnits, type Abi } from 'viem'
import { API } from '@/lib/api'
import { usePicture } from '@/lib/picture'
import { useUsdgBalance } from '@/lib/balance'
import { useMaxNotional } from '@/lib/router'
import { AmountField, binding, toUsdg } from '@/components/AmountField'
import {
  addresses,
  basketFactoryAbi,
  basketRouterAbi,
  colorOf,
  factoryAddress,
  tokenList,
} from '@/lib/contracts'

type Row = { address: `0x${string}`; symbol: string; name: string; fee: number; weight: number }

/** Spread 100 across n holdings, with the remainder on the first. */
function evenWeights(n: number): number[] {
  if (n === 0) return []
  const base = Math.floor(100 / n)
  const out = new Array(n).fill(base)
  out[0] += 100 - base * n
  return out
}

/**
 * The raise sizes offered, in whole dollars.
 *
 * Not free text, because the number decides the whole shape of the thing and a
 * creator typing one has no way to know what it means. Four sizes with what
 * each one buys written next to it is a choice somebody can actually make.
 *
 * **Filtered against the router's own size cap at render time.** Graduation
 * spends the raise through `router.buy`, which is subject to
 * `Guarded.maxNotional` like any other buy, and the live router is deployed
 * with that at $25,000. Offering $48,000 and $100,000 anyway meant two of the
 * four tabs were a wallet prompt that reverts `ThresholdOverCap`, which the
 * curve's constructor is right to do and the form was wrong to walk into.
 */
const THRESHOLDS = [10_000, 25_000, 48_000, 100_000]


/**
 * Launching a basket token.
 *
 * Deliberately the same four steps as `/launch`, because it is the same act
 * with one thing added and one thing changed. Added: a picture, which a token
 * people are going to name and share needs and an index does not. Changed: it
 * raises to a threshold on a curve first, and only then buys the stock, so
 * there is a raise size to pick where a motif has nothing to pick.
 *
 * The picture is the only part of this that touches a server. Everything else
 * is a wallet and a contract.
 */
export function LaunchToken() {
  const { isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()
  const fileInput = useRef<HTMLInputElement>(null)

  const [rows, setRows] = useState<Row[]>(() =>
    [tokenList[0]!, tokenList[1]!].map((t, i) => ({ ...t, weight: evenWeights(2)[i]! })),
  )
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [threshold, setThreshold] = useState(10_000)
  const [feeBps, setFeeBps] = useState(50)
  const [devBuy, setDevBuy] = useState('')
  const pic = usePicture()

  /**
   * The largest raise this router will let a graduation spend, in whole
   * dollars, or null for no cap and undefined while it is being read.
   *
   * @dev Read through the factory rather than from the configured router
   *      address, because the factory is what actually builds the curve and a
   *      site pointed at one and a factory pointed at another is exactly the
   *      kind of mismatch this would otherwise hide.
   */
  const [cap, setCap] = useState<number | null | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [launched, setLaunched] = useState<`0x${string}` | null>(null)

  useEffect(() => {
    if (!client || !factoryAddress) return
    let off = false
    ;(async () => {
      try {
        const router = (await client.readContract({
          address: factoryAddress,
          abi: basketFactoryAbi,
          functionName: 'router',
        })) as `0x${string}`
        const max = (await client.readContract({
          address: router,
          abi: basketRouterAbi,
          functionName: 'maxNotional',
        })) as bigint
        if (!off) setCap(max === 0n ? null : Number(max / 1_000_000n))
      } catch {
        // Unreadable means unknown, and unknown must not silently become "no
        // cap": the tabs stay as they are and the launch fails honestly at the
        // wallet if the guess was wrong.
        if (!off) setCap(null)
      }
    })()
    return () => { off = true }
  }, [client])

  const offered = useMemo(
    () => (cap == null ? THRESHOLDS : THRESHOLDS.filter((t) => t <= cap)),
    [cap],
  )

  // A selection the router would refuse is corrected rather than left to
  // revert, and the largest thing that fits is a better default than nothing.
  useEffect(() => {
    if (offered.length > 0 && !offered.includes(threshold)) setThreshold(offered[offered.length - 1]!)
  }, [offered, threshold])

  const total = useMemo(() => rows.reduce((s, r) => s + r.weight, 0), [rows])
  const left = 100 - total

  const nameOk = name.trim().length > 0 && name.length <= 48
  const symbolOk = symbol.trim().length > 0 && symbol.length <= 12
  /*
   * Three ceilings on a creator's own first buy, and the smallest is the one
   * that will actually stop it. The raise itself, because the curve runs out of
   * supply at the threshold and a larger buy reverts `SupplyExhausted`; the
   * router's per transaction cap, which the graduation buy has to clear later
   * anyway; and what the wallet actually holds. An unknown one is left out
   * rather than counted as zero.
   */
  const routerCap = useMaxNotional()
  const balance = useUsdgBalance()
  const buyLimit = useMemo(
    () =>
      binding([
        { max: parseUnits(String(threshold), 6), why: 'which is the whole raise' },
        routerCap === null
          ? null
          : { max: routerCap, why: "the router's cap on any single transaction" },
        balance === null ? null : { max: balance, why: 'which is all the USDG this wallet holds' },
      ]),
    [threshold, routerCap, balance],
  )
  const overBuy = buyLimit !== null && toUsdg(devBuy) > buyLimit.max

  const valid =
    total === 100 &&
    rows.length > 0 &&
    nameOk &&
    symbolOk &&
    description.length <= 280 &&
    !overBuy

  function toggle(token: `0x${string}`) {
    setRows((rs) => {
      const has = rs.some((r) => r.address === token)
      const next = has
        ? rs.filter((r) => r.address !== token)
        : [...rs, { ...tokenList.find((t) => t.address === token)!, weight: 0 }]
      const w = evenWeights(next.length)
      return next.map((r, i) => ({ ...r, weight: w[i]! }))
    })
  }

  async function submit() {
    if (!client || !factoryAddress) return
    // Captured, because the narrowing above does not survive the awaits below.
    const factory = factoryAddress
    setError(null)
    try {
      let firstBuy = 0n
      try {
        firstBuy = parseUnits(devBuy || '0', 6)
      } catch {
        firstBuy = 0n
      }

      // The usdg goes to the factory, which spends it on the curve inside the
      // same call, so the approval is to the factory rather than to a curve
      // that does not exist yet.
      if (firstBuy > 0n) {
        setBusy('Approving USDG')
        const a = await writeContractAsync({
          address: addresses.usdg,
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [factory, firstBuy],
        })
        await client.waitForTransactionReceipt({ hash: a })
      }

      const meta = [
        rows.map((r) => ({ token: r.address, fee: r.fee, weightBps: Math.round(r.weight * 100) })),
        feeBps,
        parseUnits(String(threshold), 6),
        name.trim(),
        symbol.trim().toUpperCase(),
        description.trim(),
        pic.image,
      ]

      setBusy('Launching')
      // One transaction, not a launch and then a buy. Between those two the
      // curve is open and its cheapest tokens are the first ones, so whoever is
      // watching takes the opening position the creator was paying for.
      const hash = await writeContractAsync({
        address: factory,
        abi: basketFactoryAbi,
        functionName: firstBuy > 0n ? 'launchAndBuy' : 'launch',
        args: (firstBuy > 0n ? [...meta, firstBuy, 0n] : meta) as never,
      })
      const receipt = await client.waitForTransactionReceipt({ hash })

      // Read the address out of this transaction's own log rather than off the
      // end of the factory's list. The list is append only, so the last entry
      // is usually this launch, and usually is not good enough: two launches in
      // one block would send one of the two creators to the other's token.
      //
      // Narrowed to the factory's own logs first. `parseEventLogs` decodes
      // whatever it is given and this receipt carries the curve's, the vault's,
      // the router's and the pool's as well; matching on a signature alone
      // trusts that nothing else in the transaction ever emits one that looks
      // the same. Nothing does today, and the address is known here.
      //
      // Cast because the generated abi is plain json rather than `as const`, so
      // viem has no literal types to infer the args from.
      const [log] = parseEventLogs({
        abi: basketFactoryAbi as Abi,
        eventName: 'Launched',
        logs: receipt.logs.filter(
          (l) => l.address.toLowerCase() === factory.toLowerCase(),
        ),
      }) as unknown as { args: { curve: `0x${string}` } }[]
      if (!log) throw new Error('Launched, but the transaction carried no Launched log')
      setLaunched(log.args.curve)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      setError(m.split('\n')[0]?.slice(0, 200) ?? 'Failed')
    } finally {
      setBusy(null)
    }
  }

  if (launched !== null) {
    return (
      <section className="view">
        <div className="wrap" style={{ maxWidth: 620 }}>
          <div className="card" style={{ textAlign: 'center', padding: '46px 26px' }}>
            <div className="num up" style={{ fontSize: 13, letterSpacing: '.14em' }}>
              LAUNCHED
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, margin: '14px 0 8px' }}>
              {name || 'Your basket token'}
            </div>
            <p className="dim" style={{ lineHeight: 1.7 }}>
              The curve is open and anyone can buy on it. At ${threshold.toLocaleString('en-US')} it
              graduates: the raise buys the real stock into a vault, the token starts trading against its
              own pool, and you earn that pool&rsquo;s 0.3% for as long as it exists.
            </p>
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <Link className="btn" href={`/t/${launched}`}>
                Open its page
              </Link>
              <Link className="btn ghost" href="/tokens">
                See them all
              </Link>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="view">
      <div className="wrap" style={{ maxWidth: 820 }}>
        <h1 className="label">Launch a basket token</h1>
        <p className="lede" style={{ marginTop: 0, marginBottom: 30 }}>
          Pick the stocks, name it, give it a picture. People buy it on a curve, and when the raise
          fills, the money buys the real shares into a vault that every holder can redeem from. Your
          token&rsquo;s downside is what those shares are worth rather than zero.
        </p>

        {!factoryAddress && (
          <div className="notice bad" style={{ marginBottom: 20 }}>
            <b>No factory is configured on this build.</b> Basket tokens are not deployed yet, so there is
            nothing to launch against. The form below is real and the button is not.
          </div>
        )}

        {/* ------------------------------------------------------- step one */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">01</span>
            <div>
              <div className="stepbox-t">Pick what backs it</div>
              <div className="stepbox-d dim small">
                Real tokenised equities. These are what the raise buys and what a holder redeems.
              </div>
            </div>
          </div>

          <div className="picker">
            {tokenList.map((t) => {
              const on = rows.some((r) => r.address === t.address)
              return (
                <button
                  key={t.address}
                  className={`pick${on ? ' on' : ''}`}
                  onClick={() => toggle(t.address)}
                  type="button"
                >
                  <span className="pick-sym num">{t.symbol}</span>
                  <span className="pick-name">{t.name}</span>
                </button>
              )
            })}
          </div>
        </div>

        {/* ------------------------------------------------------- step two */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">02</span>
            <div>
              <div className="stepbox-t">Set the weights</div>
              <div className="stepbox-d dim small">
                They have to add up to exactly 100%, and they can never be changed afterwards.
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="dim small">Pick at least one holding above.</div>
          ) : (
            <>
              <div className="weights" style={{ marginTop: 0, marginBottom: 20, height: 8 }}>
                {rows.map((r) => (
                  <span key={r.address} style={{ width: `${Math.max(0, r.weight)}%`, background: colorOf(r.address) }} />
                ))}
                {left > 0 && <span style={{ width: `${left}%`, background: 'var(--line-2)' }} />}
              </div>

              {rows.map((r, i) => (
                <div className="wrow" key={r.address}>
                  <div className="wrow-sym">
                    <i className="swatch" style={{ background: colorOf(r.address) }} />
                    <b>{r.symbol}</b>
                    <span className="dim small" style={{ marginLeft: 8 }}>
                      {r.name}
                    </span>
                  </div>
                  <input
                    className="slider"
                    type="range"
                    min={0}
                    max={100}
                    value={r.weight}
                    onChange={(e) =>
                      setRows((rs) => rs.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))
                    }
                  />
                  <div className="wrow-pct num">{r.weight}%</div>
                  <button className="wrow-x" onClick={() => toggle(r.address)} aria-label={`Remove ${r.symbol}`} type="button">
                    ×
                  </button>
                </div>
              ))}

              <div className="row wrow-foot">
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() =>
                    setRows((rs) => {
                      const w = evenWeights(rs.length)
                      return rs.map((r, i) => ({ ...r, weight: w[i]! }))
                    })
                  }
                >
                  Split evenly
                </button>
                <div className={`num ${total === 100 ? 'up' : 'warm'}`}>
                  {total === 100 ? 'adds up to 100%' : left > 0 ? `${left}% left to give out` : `${-left}% over`}
                </div>
              </div>
            </>
          )}
        </div>

        {/* ----------------------------------------------------- step three */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">03</span>
            <div>
              <div className="stepbox-t">Name it, and give it a face</div>
              <div className="stepbox-d dim small">
                All of this is written on chain at launch and none of it can be changed after.
              </div>
            </div>
          </div>

          <div className="namebar">
            <div>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value.slice(0, 48))} placeholder="AI Core" />
            </div>
            <div>
              <label>Ticker</label>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase().slice(0, 12))}
                placeholder="AICORE"
              />
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <label>One line about it, optional</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 280))}
              placeholder="What is this and why should anyone hold it?"
            />
            <div className="dim small" style={{ marginTop: 6, textAlign: 'right' }}>
              {description.length}/280
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <label>Picture, optional</label>
            <div className="row" style={{ gap: 16, alignItems: 'center', marginTop: 8 }}>
              <div className="tokenpic">
                {pic.preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={pic.preview} alt="" />
                ) : (
                  <div className="tokenpic-bands">
                    {rows.map((r) => (
                      <span key={r.address} style={{ height: `${Math.max(0, r.weight)}%`, background: colorOf(r.address) }} />
                    ))}
                  </div>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void pic.upload(f)
                  }}
                />
                <button className="btn ghost" type="button" disabled={pic.uploading} onClick={() => fileInput.current?.click()}>
                  {pic.uploading ? 'Uploading' : pic.preview ? 'Choose another' : 'Choose a picture'}
                </button>
                {pic.preview && (
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ marginLeft: 8 }}
                    onClick={pic.clear}
                  >
                    Remove
                  </button>
                )}
                <div className="dim small" style={{ marginTop: 10, lineHeight: 1.6 }}>
                  PNG, JPEG, GIF or WebP, up to 512KB. Without one the tile is drawn from the weights, which
                  is what every motif on this site already does.
                </div>
              </div>
            </div>
            {pic.error && (
              <div className="notice bad" style={{ marginTop: 12 }}>
                {pic.error}
              </div>
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ step four */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">04</span>
            <div>
              <div className="stepbox-t">The raise, and your fee</div>
              <div className="stepbox-d dim small">Both set once, at launch, and never again.</div>
            </div>
          </div>

          <label>Graduates at</label>
          <div className="quickbar">
            {offered.map((t) => (
              <button key={t} type="button" className={`tab${threshold === t ? ' on' : ''}`} onClick={() => setThreshold(t)}>
                ${t.toLocaleString('en-US')}
              </button>
            ))}
          </div>
          {cap != null && offered.length < THRESHOLDS.length && (
            <div className="dim small" style={{ marginTop: 8, lineHeight: 1.6 }}>
              Larger raises are not offered because the router will not spend more than{' '}
              <b className="num">${cap.toLocaleString('en-US')}</b> in one transaction, and graduation is one
              transaction. The guardian can raise that cap; until they do, a bigger threshold is money that
              could be raised and never spent.
            </div>
          )}
          <div className="dim small" style={{ marginTop: 8, lineHeight: 1.6 }}>
            Of that, <b className="num">${(threshold * 0.8).toLocaleString('en-US')}</b> buys the real
            stock into the vault and <b className="num">${(threshold * 0.2).toLocaleString('en-US')}</b>{' '}
            seeds the token&rsquo;s own pool on both sides. A bigger raise is a deeper pool, which is the
            difference between a token people can trade and one they cannot.
          </div>

          <div style={{ marginTop: 24 }}>
            <label>Your fee on the graduation buy</label>
            <div className="feebar">
              <input
                className="slider"
                type="range"
                min={0}
                max={100}
                step={5}
                value={feeBps}
                onChange={(e) => setFeeBps(Number(e.target.value))}
              />
              <div className="feebar-v num">{(feeBps / 100).toFixed(2)}%</div>
            </div>
            <div className="dim small" style={{ marginTop: 8, lineHeight: 1.6 }}>
              <b className="num up">${((threshold * feeBps) / 10_000).toFixed(0)}</b> once, when it
              graduates. The money that keeps coming is the pool&rsquo;s 0.3% on every trade of your token
              afterwards, which is paid to you and to nobody else, forever, and comes out of traders rather
              than out of the backing.
            </div>
          </div>

          {/* The creator's own first position, in the launch itself. It has to
              be the same transaction: between a launch and a separate buy the
              curve is open and its cheapest tokens are the first ones, so
              whoever is watching takes the opening position the creator was
              paying for. `BasketFactory.launchAndBuy` is that transaction. */}
          <AmountField
            label="Buy your own at launch, optional"
            value={devBuy}
            onChange={setDevBuy}
            limit={buyLimit}
            help={
              <>
                Any amount you like, including nothing. It buys on the curve at the opening price,
                in the same transaction that launches it, so nobody can take the first position off
                you. It counts towards the raise, and you can sell it back along the curve at any
                time before it graduates.
              </>
            }
          />
        </div>

        <div className="notice">
          <b>Nothing here can be edited afterwards.</b> Not the weights, not the name, not the picture, not
          the threshold, not your fee. There is no admin, no pause and no upgrade, which is also why nobody
          can take the stock out of the vault once it is in there.
        </div>

        {error && (
          <div className="notice bad" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="launchbar">
          <button className="btn" disabled={!isConnected || !valid || !!busy || !factoryAddress} onClick={submit}>
            {busy ??
              (!factoryAddress
                ? 'Not deployed yet'
                : !isConnected
                  ? 'Connect a wallet first'
                  : rows.length === 0
                    ? 'Pick at least one holding'
                    : total !== 100
                      ? left > 0
                        ? `${left}% still to give out`
                        : `${-left}% over 100%`
                      : !nameOk
                        ? 'Give it a name'
                        : !symbolOk
                          ? 'Give it a ticker'
                          : 'Launch it')}
          </button>
          <span className="dim small">
            {rows.length} holding{rows.length === 1 ? '' : 's'} · raises $
            {threshold.toLocaleString('en-US')} · {(feeBps / 100).toFixed(2)}% fee
          </span>
        </div>
      </div>
    </section>
  )
}
