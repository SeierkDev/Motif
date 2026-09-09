'use client'

import { useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from 'wagmi'
import { parseAbi, parseUnits } from 'viem'
import { addresses, basketRouterAbi, tokenList, colorOf } from '@/lib/contracts'
import { usePicture } from '@/lib/picture'
import { routerTakesImage, useMaxNotional, useRouterImages } from '@/lib/router'
import { useUsdgBalance } from '@/lib/balance'
import { pictureMessage, setMotifPicture } from '@/lib/api'
import { AmountField, binding, toUsdg } from '@/components/AmountField'

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
 * Publishing a motif, as four steps rather than a form.
 *
 * The previous version was a table of selects, a fee tier column and two raw
 * number fields, which read as a control panel: correct, and nothing anyone
 * would enjoy using. Holdings are picked by tapping a ticker, weights move on
 * sliders with the running total in front of you, the fee is a percentage
 * rather than basis points, and the card people will actually see is drawn as
 * you type.
 *
 * The fee tier is gone from the interface entirely. It was never a choice: each
 * ticker has exactly one pool worth routing through, and the app already knows
 * which. Asking was making the user answer a question on the contract's behalf.
 */
export function Create() {
  const { isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [rows, setRows] = useState<Row[]>(() =>
    [tokenList[0]!, tokenList[1]!, tokenList[2]!].map((t, i) => ({
      ...t,
      weight: evenWeights(3)[i]!,
    })),
  )
  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const pic = usePicture()
  const canPicture = useRouterImages()
  const { signMessageAsync } = useSignMessage()
  const [picNote, setPicNote] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // Empty rather than a number somebody did not choose: with the presets
  // gone there is nothing to unselect, so a prefilled amount is money spent by
  // default.
  const [devBuy, setDevBuy] = useState('')
  const [feeBps, setFeeBps] = useState(25)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<number | null>(null)

  const total = useMemo(() => rows.reduce((s, r) => s + r.weight, 0), [rows])
  const left = 100 - total

  /*
   * Two separate ceilings on a creator's own buy, and the smaller one is the
   * one that will actually stop it. The router's `maxNotional` bounds what any
   * single call may spend while these contracts are unaudited; the wallet's own
   * usdg balance bounds it after that. Either unknown is left out rather than
   * treated as zero: a read that has not come back is not a limit of nothing.
   */
  const cap = useMaxNotional()
  const balance = useUsdgBalance()
  const buyLimit = useMemo(
    () =>
      binding([
        cap === null ? null : { max: cap, why: "the router's cap on any single transaction" },
        balance === null ? null : { max: balance, why: 'which is all the USDG this wallet holds' },
      ]),
    [cap, balance],
  )
  const overCap = buyLimit !== null && toUsdg(devBuy) > buyLimit.max

  const nameOk = name.trim().length > 0 && name.length <= 48
  const symbolOk = symbol.trim().length > 0 && symbol.length <= 12
  const valid =
    total === 100 && rows.length > 0 && nameOk && symbolOk && description.length <= 280 && !overCap

  function toggle(address: `0x${string}`) {
    setRows((rs) => {
      const has = rs.some((r) => r.address === address)
      const next = has
        ? rs.filter((r) => r.address !== address)
        : [...rs, { ...tokenList.find((t) => t.address === address)!, weight: 0 }]
      // Re-spreading on every change keeps the total at 100 without anybody
      // doing arithmetic, and the sliders are still there to override it.
      const w = evenWeights(next.length)
      return next.map((r, i) => ({ ...r, weight: w[i]! }))
    })
  }

  function setWeight(i: number, weight: number) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, weight } : r)))
  }

  async function submit() {
    if (!client) return
    setError(null)
    try {
      const legs = rows.map((r) => ({
        token: r.address,
        fee: r.fee,
        weightBps: Math.round(r.weight * 100),
      }))
      let amountIn = 0n
      try {
        amountIn = parseUnits(devBuy || '0', 6)
      } catch {
        amountIn = 0n
      }

      // A creator buy needs an approval first, the same as any other purchase.
      if (amountIn > 0n) {
        setBusy('Approving USDG')
        const a = await writeContractAsync({
          address: addresses.usdg,
          abi: parseAbi(['function approve(address,uint256) returns (bool)']),
          functionName: 'approve',
          args: [addresses.basketRouter, amountIn],
        })
        await client.waitForTransactionReceipt({ hash: a })
      }

      // Both of these are overloaded, and viem picks between the shapes on
      // arity, so the argument count here chooses the selector. The longer one
      // carries the picture and only exists on a router published since
      // pictures did; the shorter one is the original and every router has it.
      // Passing the wrong length is silent in both directions: too few drops
      // the picture on a launch that otherwise succeeds, too many reverts with
      // nothing attached against a router that has no fallback. So the picture
      // decides, and when there is one the router is asked first rather than
      // found out about after the approval has been signed.
      const withImage = pic.image.length > 0

      /*
       * Where the picture goes, which is not always the chain.
       *
       * A router published since pictures exist takes a seventh argument and
       * the url ends up in its log. The one deployed here predates that, and
       * replacing it means a new address, a new factory bound to it and
       * abandoning every motif already published, which is a large price for a
       * thumbnail. So when the router cannot take it, the picture is attached
       * to the api afterwards instead, signed by the creator.
       *
       * That is less of a downgrade than it sounds. The picture was never on
       * chain in either case: the log holds a url pointing back at this site's
       * own image store, so the bytes live on that disk regardless. On chain
       * the pointer is immutable, and a permanent pointer to a server that is
       * gone is worth nothing.
       */
      let onChain = false
      if (withImage) {
        const takes = await routerTakesImage(client as never)
        if (takes === null) {
          throw new Error(
            'Could not reach the chain to check whether a picture can be recorded. Nothing was sent. Try again.',
          )
        }
        onChain = takes
      }
      const base = [
        addresses.usdg,
        legs,
        feeBps,
        name.trim(),
        symbol.trim().toUpperCase(),
        description.trim(),
      ]
      const meta = onChain ? [...base, pic.image] : base

      setBusy('Publishing')
      const hash =
        amountIn > 0n
          ? await writeContractAsync({
              address: addresses.basketRouter,
              abi: basketRouterAbi,
              functionName: 'createAndBuy',
              args: [...meta, amountIn, legs.map(() => 0n)] as never,
            })
          : await writeContractAsync({
              address: addresses.basketRouter,
              abi: basketRouterAbi,
              functionName: 'createIndex',
              args: meta as never,
            })
      await client.waitForTransactionReceipt({ hash })
      const count = (await client.readContract({
        address: addresses.basketRouter,
        abi: basketRouterAbi,
        functionName: 'indexCount',
      })) as bigint
      const id = Number(count) - 1

      /*
       * The motif exists at this point, so a failure here must not read as a
       * failed launch. Worst case the picture is missing and everything else
       * landed, which is why this is caught separately and only reported as a
       * note beside the success.
       */
      if (withImage && !onChain) {
        setBusy('Attaching the picture')
        try {
          const signature = await signMessageAsync({ message: pictureMessage(id, pic.image) })
          await setMotifPicture(id, pic.image, signature)
        } catch {
          setPicNote(
            'The motif published, but the picture was not attached. Open it and try again from its page.',
          )
        }
      }

      setCreated(id)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      setError(m.split('\n')[0]?.slice(0, 200) ?? 'Failed')
    } finally {
      setBusy(null)
    }
  }

  if (created !== null) {
    return (
      <section className="view">
        <div className="wrap" style={{ maxWidth: 620 }}>
          <div className="card" style={{ textAlign: 'center', padding: '46px 26px' }}>
            <div className="num up" style={{ fontSize: 13, letterSpacing: '.14em' }}>
              PUBLISHED
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, margin: '14px 0 8px' }}>
              {name || `Motif #${created}`}
            </div>
            <p className="dim" style={{ lineHeight: 1.7 }}>
              It is on chain and anyone can buy it. Share the link and you earn{' '}
              {(feeBps / 100).toFixed(2)}% of every purchase, in the same transaction it happens.
            </p>
            {picNote && (
              <div className="notice" style={{ marginTop: 14, textAlign: 'left' }}>
                {picNote}
              </div>
            )}
            <div className="hero-cta" style={{ justifyContent: 'center' }}>
              <Link className="btn" href={`/m/${created}`}>
                Open its page
              </Link>
              <Link className="btn ghost" href="/explore">
                See the leaderboard
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
        <h1 className="label">Launch a motif</h1>
        <p className="lede" style={{ marginTop: 0, marginBottom: 18 }}>
          Four steps and one transaction. Anyone can then buy the whole basket at once, and you earn
          your fee on every purchase, forever.
        </p>
        <p className="dim small" style={{ marginTop: 0, marginBottom: 30, lineHeight: 1.7 }}>
          A motif is bought as its parts: spend a hundred dollars and the stock lands in your own
          wallet. If you want a token of your own instead, with a picture, a curve and a price that
          can run,{' '}
          <Link href="/tokens/new">launch a basket token</Link>. Same stocks underneath, and it holds
          them in a vault anyone can redeem from.
        </p>

        {/* ------------------------------------------------------- step one */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">01</span>
            <div>
              <div className="stepbox-t">Pick the holdings</div>
              <div className="stepbox-d dim small">Tap a ticker to add or remove it.</div>
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
                They have to add up to exactly 100%, because a basket that does not is not a basket.
              </div>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="dim small">Pick at least one holding above.</div>
          ) : (
            <>
              <div className="weights" style={{ marginTop: 0, marginBottom: 20, height: 8 }}>
                {rows.map((r, i) => (
                  <span
                    key={r.address}
                    style={{
                      width: `${Math.max(0, r.weight)}%`,
                      background: colorOf(r.address),
                    }}
                  />
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
                    onChange={(e) => setWeight(i, Number(e.target.value))}
                  />
                  <div className="wrow-pct num">{r.weight}%</div>
                  <button
                    className="wrow-x"
                    onClick={() => toggle(r.address)}
                    aria-label={`Remove ${r.symbol}`}
                    type="button"
                  >
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
                  {total === 100
                    ? 'adds up to 100%'
                    : left > 0
                      ? `${left}% left to give out`
                      : `${-left}% over`}
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
              <div className="stepbox-t">Name it</div>
              <div className="stepbox-d dim small">
                Written on chain when it launches, and never editable afterwards.
              </div>
            </div>
          </div>

          <div className="namebar">
            <div>
              <label>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, 48))}
                placeholder="AI Core"
              />
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
              placeholder="What is this and why should anyone buy it?"
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
                      <span
                        key={r.address}
                        style={{ height: `${Math.max(0, r.weight)}%`, background: colorOf(r.address) }}
                      />
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
                <button
                  className="btn ghost"
                  type="button"
                  disabled={pic.uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  {pic.uploading ? 'Uploading' : pic.preview ? 'Choose another' : 'Choose a picture'}
                </button>
                {pic.preview && (
                  <button className="btn ghost" type="button" style={{ marginLeft: 8 }} onClick={pic.clear}>
                    Remove
                  </button>
                )}
                <div className="dim small" style={{ marginTop: 10, lineHeight: 1.6 }}>
                  PNG, JPEG, GIF or WebP, up to 512KB. Without one the tile is drawn from the weights, which
                  is what every motif here did before this existed. The weights stay either way: with a
                  picture they move to a strip along the bottom of the tile.
                </div>
                {canPicture === false && (
                  <div className="dim small" style={{ marginTop: 10, lineHeight: 1.6 }}>
                    The router deployed on this chain cannot record a picture in its log, so this one is
                    kept with the site instead and you will be asked to sign a message proving the motif is
                    yours. The signing is free and sends no transaction. The picture itself is stored the
                    same way either way: on chain the log holds a link to this site, not the image.
                  </div>
                )}
              </div>
            </div>
            {pic.error && (
              <div className="notice bad" style={{ marginTop: 12 }}>
                {pic.error}
              </div>
            )}
          </div>

          <div className="preview">
            <div className="side-label num">How it will look</div>
            <div className="mcard" style={{ cursor: 'default' }}>
              <div className="mcard-top">
                <div style={{ minWidth: 0 }}>
                  <div className="mcard-name">{name.trim() || 'Untitled motif'}</div>
                  <div className="num dim small">{symbol.trim() || 'TICKER'}</div>
                </div>
                <div className="num dim" style={{ fontSize: 15 }}>
                  —
                </div>
              </div>
              <div className="weights">
                {rows.map((r, i) => (
                  <span
                    key={r.address}
                    style={{
                      width: `${Math.max(0, r.weight)}%`,
                      background: colorOf(r.address),
                    }}
                  />
                ))}
              </div>
              <div className="legs">
                {rows.slice(0, 4).map((r, i) => (
                  <span className="chip" key={r.address}>
                    <i className="swatch" style={{ background: colorOf(r.address) }} />
                    <b>{r.symbol}</b> {r.weight}%
                  </span>
                ))}
                {rows.length > 4 && <span className="chip">+{rows.length - 4} more</span>}
              </div>
              {description.trim() && (
                <div className="dim small" style={{ marginTop: 14, lineHeight: 1.6 }}>
                  {description.trim()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------ step four */}
        <div className="stepbox">
          <div className="stepbox-head">
            <span className="stepbox-n num">04</span>
            <div>
              <div className="stepbox-t">Your fee, and your own buy</div>
              <div className="stepbox-d dim small">Both optional. Both set once, at launch.</div>
            </div>
          </div>

          <label>Your fee on every purchase</label>
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
            On $10,000 of buying that is{' '}
            <b className="num up">${((10_000 * feeBps) / 10_000).toFixed(0)}</b> to you, paid inside
            each purchase. Capped at 1% so a published index cannot be predatory.
          </div>

          <AmountField
            label="Buy your own at launch, optional"
            value={devBuy}
            onChange={setDevBuy}
            limit={buyLimit}
            help={
              <>
                Any amount you like, including nothing. Bought in the same transaction that
                publishes it, so your motif arrives with real volume rather than as an empty row.
              </>
            }
          />
        </div>

        <div className="notice">
          <b>A motif can never be edited.</b> If weights could change after people bought in, a
          creator could wait for buyers and then repoint it at something worthless. Changing your
          mind means publishing a new one.
        </div>

        {error && (
          <div className="notice bad" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="launchbar">
          <button className="btn" disabled={!isConnected || !valid || !!busy} onClick={submit}>
            {busy ??
              (!isConnected
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
            {rows.length} holding{rows.length === 1 ? '' : 's'} · {(feeBps / 100).toFixed(2)}% fee ·{' '}
            {Number(devBuy) > 0 ? `$${devBuy} of your own` : 'no buy of your own'}
          </span>
        </div>
      </div>
    </section>
  )
}
