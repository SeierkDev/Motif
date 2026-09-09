'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { formatUnits, parseAbi } from 'viem'
import { addresses, rebalancerAbi, ordersAbi, tokenList, symbolOf } from '@/lib/contracts'
import { poolSpot } from '@/lib/quote'
import { useApi, usdg, short, ago, pct, tone, type Motif } from '@/lib/api'
import { SellPanel } from './SellPanel'

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

type Holding = { token: `0x${string}`; symbol: string; balance: bigint; price: bigint; value: bigint }

type Sub = {
  indexId: bigint
  driftBps: number
  maxSlippageBps: number
  maxPriceAge: number
  cooldown: number
  lastRebalanceAt: bigint
  active: boolean
}

const money = (v: bigint) =>
  '$' +
  Number(formatUnits(v, 18)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/**
 * The reasons this page writes its own copy for. Anything else falls through to
 * the contract's own wording rather than to an empty box.
 */
const KNOWN_REASONS = [
  'price too stale',
  'corporate action pending',
  'within tolerance',
  'cooldown',
  'no price feed for a leg',
]

/**
 * What a holder actually wants to know after buying, which the previous version
 * of this page could not answer at all: what do I hold, what is it worth, and
 * what is running against it.
 */
export function Portfolio() {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [sub, setSub] = useState<Sub | null>(null)
  const [subState, setSubState] = useState<{ ok: boolean; why: string } | null>(null)
  const [drift, setDrift] = useState<number | null>(null)
  const [openOrders, setOpenOrders] = useState<number>(0)
  const [selling, setSelling] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: mine } = useApi<{ address: string; buys: { index_id: number; amount_in: string; ts: number }[] }>(
    address ? `/v1/holders/${address}` : null,
    15_000,
  )
  const { data: board } = useApi<{ indexes: Motif[] }>('/v1/leaderboard?by=volume&limit=200', 20_000)

  const load = useCallback(async () => {
    if (!client || !address) return
    setError(null)
    try {
      // Every ticker with a pool, priced once. A wallet holding three of them
      // should not cost three round trips per ticker.
      const rows = await Promise.all(
        tokenList.map(async (t) => {
          const [balance, price] = await Promise.all([
            client.readContract({
              address: t.address, abi: erc20, functionName: 'balanceOf', args: [address],
            }) as Promise<bigint>,
            poolSpot(client, t.address, t.fee).catch(() => 0n),
          ])
          return {
            token: t.address, symbol: t.symbol, balance, price,
            value: (balance * price) / 10n ** 18n,
          }
        }),
      )
      setHoldings(rows.filter((r) => r.balance > 0n).sort((a, b) => (b.value > a.value ? 1 : -1)))

      const s = (await client.readContract({
        address: addresses.rebalancer, abi: rebalancerAbi, functionName: 'subs', args: [address],
      })) as unknown as unknown[]
      const parsed: Sub = {
        indexId: s[0] as bigint, driftBps: Number(s[1]), maxSlippageBps: Number(s[2]),
        maxPriceAge: Number(s[3]), cooldown: Number(s[4]),
        lastRebalanceAt: s[5] as bigint, active: s[6] as boolean,
      }
      setSub(parsed)

      if (parsed.active) {
        const r = (await client.readContract({
          address: addresses.rebalancer, abi: rebalancerAbi, functionName: 'shouldRebalance', args: [address],
        })) as unknown as [boolean, string]
        setSubState({ ok: r[0], why: r[1] })
        try {
          const p = (await client.readContract({
            address: addresses.rebalancer, abi: rebalancerAbi, functionName: 'positionOf', args: [address],
          })) as unknown as [bigint[], bigint, bigint]
          setDrift(Number(p[2]))
        } catch {
          // positionOf reverts on a stale feed, which is correct and not an
          // error to hide. shouldRebalance already says why.
          setDrift(null)
        }
      }

      const ids = (await client.readContract({
        address: addresses.orders, abi: ordersAbi, functionName: 'ordersOf', args: [address],
      })) as bigint[]
      let open = 0
      for (const id of ids) {
        const o = (await client.readContract({
          address: addresses.orders, abi: ordersAbi, functionName: 'get', args: [id],
        })) as unknown as { active: boolean }
        if (o.active) open++
      }
      setOpenOrders(open)
    } catch (e) {
      setError((e as Error).message.split('\n')[0]!)
    }
  }, [client, address])

  useEffect(() => { load() }, [load])

  async function call(fn: 'unsubscribe' | 'acknowledgeCorporateActions') {
    if (!client) return
    setBusy(fn === 'unsubscribe' ? 'Turning off' : 'Acknowledging')
    try {
      const hash = await writeContractAsync({
        address: addresses.rebalancer, abi: rebalancerAbi, functionName: fn,
      })
      await client.waitForTransactionReceipt({ hash })
      await load()
    } catch (e) { setError((e as Error).message.split('\n')[0]!) } finally { setBusy(null) }
  }

  if (!isConnected) {
    return (
      <section className="view"><div className="wrap">
        <h1 className="label">Portfolio</h1>
        <div className="card dim">Connect a wallet to see what you hold.</div>
      </div></section>
    )
  }

  const total = (holdings ?? []).reduce((n, h) => n + h.value, 0n)
  const boughtIds = [...new Set((mine?.buys ?? []).map((b) => b.index_id))]
  const bought = (board?.indexes ?? []).filter((m) => boughtIds.includes(m.id))

  return (
    <section className="view">
      <div className="wrap">
        <h1 className="label">Portfolio</h1>
        {error && <div className="notice bad" style={{ marginBottom: 14 }}>{error}</div>}

        <div className="strip" style={{ marginTop: 0 }}>
          <div><div className="k">Holdings value</div><div className="v">{holdings ? money(total) : '—'}</div></div>
          <div><div className="k">Tickers held</div><div className="v">{holdings?.length ?? '—'}</div></div>
          <div><div className="k">Motifs bought</div><div className="v">{bought.length}</div></div>
          <div><div className="k">Open orders</div><div className="v">{openOrders}</div></div>
        </div>

        <h2 style={{ marginTop: 32 }}>What you hold</h2>
        {holdings === null && <div className="card dim">Reading your wallet…</div>}
        {holdings?.length === 0 && (
          <div className="card dim">
            Nothing yet. <a className="up" href="/explore">Buy a motif</a> and the tokens land here,
            in your own wallet.
          </div>
        )}
        {holdings && holdings.length > 0 && (
          <div className="scroll-x">
          <table className="wide-rows">
            <thead><tr><th>Ticker</th><th className="n">Balance</th><th className="n">Price</th><th className="n">Value</th></tr></thead>
            <tbody>
              {holdings.map((h) => (
                <tr key={h.token}>
                  <td>{h.symbol}</td>
                  <td className="n num">{Number(formatUnits(h.balance, 18)).toFixed(4)}</td>
                  <td className="n num dim">
                    {h.price > 0n ? '$' + Number(formatUnits(h.price, 18)).toFixed(2) : '—'}
                  </td>
                  <td className="n num">{money(h.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}

        <h2 style={{ marginTop: 32 }}>Motifs you bought</h2>
        {bought.length === 0 && <div className="card dim">None yet.</div>}
        {bought.length > 0 && (
          <div className="scroll-x">
          <table className="wide-rows">
            <thead><tr><th>Motif</th><th className="n">Return</th><th className="n">You spent</th><th className="n">When</th><th className="n"></th></tr></thead>
            <tbody>
              {bought.map((m) => {
                const buys = (mine?.buys ?? []).filter((b) => b.index_id === m.id)
                const spent = buys.reduce((n, b) => n + BigInt(b.amount_in), 0n)
                const last = Math.max(...buys.map((b) => b.ts))
                return (
                  <tr key={m.id}>
                    <td>
                      <a className="up" href={`/m/${m.id}`}>{m.name}</a>{' '}
                      <span className="num dim small">{m.symbol}</span>
                    </td>
                    <td className={`n num ${tone(m.performance?.changeBps?.inception)}`}>
                      {pct(m.performance?.changeBps?.inception)}
                    </td>
                    <td className="n num">{usdg(spent.toString())}</td>
                    <td className="n dim small">{ago(last)}</td>
                    <td className="n">
                      <button
                        className="tab"
                        onClick={() => setSelling(selling === m.id ? null : m.id)}
                      >
                        {selling === m.id ? 'Close' : 'Sell'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}

        {selling !== null && (
          <div style={{ marginTop: 16 }}>
            <SellPanel
              motif={bought.find((m) => m.id === selling)!}
              onDone={() => { load() }}
            />
          </div>
        )}

        <h2 style={{ marginTop: 32 }}>Rebalancing</h2>
        {!sub?.active ? (
          <div className="card">
            <div style={{ fontWeight: 600, marginBottom: 6 }}>Off</div>
            <p className="dim small" style={{ lineHeight: 1.6 }}>
              Turned on, a keeper trades your own wallet back into ratio when a holding drifts from
              its target. Your tokens never leave your wallet, the permission carries a size and an
              expiry, and revoking it stops everything.
            </p>
            <div style={{ marginTop: 14 }}>
              <a className="btn ghost" href="/explore">Buy a motif first</a>
            </div>
          </div>
        ) : (
          <>
            <div className="strip" style={{ marginTop: 0 }}>
              <div><div className="k">Tracking</div><div className="v">#{sub.indexId.toString()}</div></div>
              <div>
                <div className="k">Worst drift</div>
                <div className={`v ${drift !== null && drift > sub.driftBps ? 'warm' : ''}`}>
                  {drift !== null ? `${(drift / 100).toFixed(2)}%` : '—'}
                </div>
              </div>
              <div><div className="k">Triggers at</div><div className="v">{(sub.driftBps / 100).toFixed(0)}%</div></div>
              <div><div className="k">Last</div><div className="v" style={{ fontSize: 16 }}>
                {sub.lastRebalanceAt > 0n ? ago(Number(sub.lastRebalanceAt)) : 'never'}
              </div></div>
            </div>

            {subState && !subState.ok && (
              <div className={`notice ${subState.why === 'corporate action pending' ? 'bad' : ''}`} style={{ marginTop: 14 }}>
                {subState.why === 'price too stale' && (
                  <>
                    <b>Prices are stale, so nothing will rebalance.</b> The stock feeds only run while
                    the market is open, so there are no prices at a weekend. Values above are the
                    last available, not live.
                  </>
                )}
                {subState.why === 'corporate action pending' && (
                  <>
                    <b>A split or dividend has changed one of your holdings.</b> Rebalancing is frozen
                    until you acknowledge it, because otherwise a two for one split reads as a 50%
                    crash and sells your position into it.
                    <div style={{ marginTop: 10 }}>
                      <button className="btn" disabled={!!busy} onClick={() => call('acknowledgeCorporateActions')}>
                        {busy ?? 'I have looked at it, resume'}
                      </button>
                    </div>
                  </>
                )}
                {subState.why === 'within tolerance' && <>Everything is inside tolerance. Nothing to do.</>}
                {subState.why === 'cooldown' && <>Recently rebalanced. Waiting out the cooldown.</>}
                {subState.why === 'no price feed for a leg' && (
                  <>
                    <b>One of these tickers has no price feed registered.</b> Rebalancing needs a price
                    for every leg and refuses to guess at one, so nothing will fire until the feed is
                    added. Your tokens are untouched and the permission can be revoked at any time.
                  </>
                )}
                {/* Anything the contract says that this page has no copy for.
                    Without it a new reason renders an empty bordered box, which
                    is what "no price feed for a leg" did the day it was added:
                    the contract grew a reason and the page had no branch. The
                    raw string is worse copy than the branches above and far
                    better than a blank notice. */}
                {!KNOWN_REASONS.includes(subState.why) && <>Not rebalancing: {subState.why}.</>}
              </div>
            )}
            {subState?.ok && (
              <div className="notice" style={{ marginTop: 14, borderLeftColor: 'var(--accent)' }}>
                <b>Drifted past your threshold.</b> A keeper can correct this now.
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <button className="btn ghost" disabled={!!busy} onClick={() => call('unsubscribe')}>
                {busy ?? 'Turn off rebalancing'}
              </button>
            </div>
          </>
        )}

        <div className="row" style={{ marginTop: 30 }}>
          <a className="btn ghost" href="/orders">Your orders ({openOrders} open)</a>
          <span className="dim small num">{address ? short(address) : ''}</span>
        </div>
      </div>
    </section>
  )
}
