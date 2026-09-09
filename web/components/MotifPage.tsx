'use client'

import { useEffect, useState } from 'react'
import { useAccount, usePublicClient, useReadContract, useWriteContract } from 'wagmi'
import { formatUnits, parseAbi, parseUnits } from 'viem'
import { addresses, basketRouterAbi, symbolOf, colorOf } from '@/lib/contracts'
import { quoteLeg, floorFrom } from '@/lib/quote'
import { useApi, usdg, usdgPrecise, short, ago, pct, tone, levelOf, type Motif, type Performance } from '@/lib/api'
import { LevelChart } from './LevelChart'

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

type Buy = { tx: string; buyer: string; amount_in: string; creator_fee: string; ts: number }

/** One motif at its own url, which is the thing people actually share. */
export function MotifPage({ id }: { id: number }) {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const { data: motif } = useApi<Motif>(`/v1/indexes/${id}`, 10_000)
  const { data: activity } = useApi<{ buys: Buy[] }>(`/v1/indexes/${id}/buys?limit=25`, 8000)
  const { data: chart } = useApi<{ levels: { at: number; level18: string }[]; performance: Performance }>(
    `/v1/indexes/${id}/history?limit=600`,
    15_000,
  )

  const { data: legsOnChain } = useReadContract({
    address: addresses.basketRouter,
    abi: basketRouterAbi,
    functionName: 'legsOf',
    args: [BigInt(id)],
  })
  const legs = (legsOnChain ?? []) as unknown as { token: `0x${string}`; fee: number; weightBps: number }[]

  /*
   * The url is in a log that can never be edited, so one day it points at
   * something that is gone. A dead `img` renders as a broken frame, which is
   * worse than no picture at all, so a failed load drops the block entirely.
   */
  const [picBroken, setPicBroken] = useState(false)
  const [amount, setAmount] = useState('100')
  const [tolerance, setTolerance] = useState(100)
  const [quotes, setQuotes] = useState<bigint[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const amountIn = (() => {
    try { return parseUnits(amount || '0', 6) } catch { return 0n }
  })()

  useEffect(() => {
    let cancelled = false
    if (!client || amountIn === 0n || legs.length === 0) { setQuotes(null); return }
    const spend = (amountIn * 9975n) / 10_000n
    Promise.all(legs.map((l) => quoteLeg(client, l.token, l.fee, (spend * BigInt(l.weightBps)) / 10_000n)))
      .then((q) => !cancelled && setQuotes(q))
      .catch(() => !cancelled && setQuotes(null))
    return () => { cancelled = true }
  }, [client, amountIn, legs])

  async function buy() {
    if (!address || !client) return
    setError(null)
    try {
      const allowance = (await client.readContract({
        address: addresses.usdg, abi: erc20, functionName: 'allowance',
        args: [address, addresses.basketRouter],
      })) as bigint
      if (allowance < amountIn) {
        setBusy('Approving USDG')
        const h = await writeContractAsync({
          address: addresses.usdg, abi: erc20, functionName: 'approve',
          args: [addresses.basketRouter, amountIn],
        })
        await client.waitForTransactionReceipt({ hash: h })
      }
      setBusy('Buying')
      const minOut = (quotes ?? legs.map(() => 0n)).map((q) => floorFrom(q, tolerance))
      const h = await writeContractAsync({
        address: addresses.basketRouter, abi: basketRouterAbi, functionName: 'buy',
        args: [BigInt(id), amountIn, minOut],
      })
      await client.waitForTransactionReceipt({ hash: h })
      setDone(true)
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      setError(m.split('\n')[0]?.slice(0, 180) ?? 'Failed')
    } finally { setBusy(null) }
  }

  if (!motif) {
    return (
      <section className="view"><div className="wrap"><div className="card dim">Loading motif #{id}…</div></div></section>
    )
  }

  return (
    <section className="view">
      <div className="wrap">
        <a href="/explore" className="dim small">&larr; All motifs</a>

        {/* The picture, where there is one. It used to appear on the tile in
            the grid and nowhere else on the site, so the one page about this
            motif was the one place its own picture was missing. A token page
            has shown it since it had one; this is the same block. */}
        <div className="row" style={{ alignItems: 'flex-start', marginTop: 14, gap: 16 }}>
          {motif.image && !picBroken && (
            <div className="tokenpic">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={motif.image} alt="" onError={() => setPicBroken(true)} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 34 }}>
              {motif.name} <span className="num dim" style={{ fontSize: 22 }}>{motif.symbol}</span>
            </h1>
            {motif.description && <p className="lede" style={{ marginTop: 10 }}>{motif.description}</p>}
            <div className="dim small" style={{ marginTop: 12 }}>
              Launched by{' '}
              <a className="up" href={`/c/${motif.creator}`}>{short(motif.creator)}</a>{' '}
              {ago(motif.ts)} · creator fee {(motif.creator_fee_bps / 100).toFixed(2)}%
            </div>
          </div>
        </div>

        <div className="strip">
          <div>
            <div className="k">Level</div>
            <div className="v">{levelOf(motif.performance)}</div>
          </div>
          <div>
            <div className="k">Since launch</div>
            <div className={`v ${tone(motif.performance?.changeBps?.inception)}`}>
              {pct(motif.performance?.changeBps?.inception)}
            </div>
          </div>
          <div>
            <div className="k">24 hours</div>
            <div className={`v ${tone(motif.performance?.changeBps?.h24)}`}>
              {pct(motif.performance?.changeBps?.h24)}
            </div>
          </div>
          <div><div className="k">Volume</div><div className="v">{usdg(motif.volume)}</div></div>
        </div>

        <div style={{ marginTop: 22 }}>
          <LevelChart points={chart?.levels ?? []} />
        </div>

        <div className="strip" style={{ marginTop: 14 }}>
          <div><div className="k">Creator earned</div><div className="v up">{usdg(motif.fees)}</div></div>
          <div><div className="k">Holders</div><div className="v">{motif.holders ?? 0}</div></div>
          <div><div className="k">Holdings</div><div className="v">{motif.legs.length}</div></div>
          <div><div className="k">Creator fee</div><div className="v">{(motif.creator_fee_bps / 100).toFixed(2)}%</div></div>
        </div>

        <div className="weights" style={{ marginTop: 22, height: 10 }}>
          {motif.legs.map((l, i) => (
            <span key={l.token} style={{ width: `${l.weight_bps / 100}%`, background: colorOf(l.token) }} />
          ))}
        </div>

        <table style={{ marginTop: 22 }}>
          <thead>
            <tr><th>Holding</th><th className="n">Weight</th><th className="n">You would receive</th></tr>
          </thead>
          <tbody>
            {motif.legs.map((l, i) => (
              <tr key={l.token}>
                <td><i className="swatch" style={{ background: colorOf(l.token) }} /> {symbolOf(l.token)}</td>
                <td className="n">{(l.weight_bps / 100).toFixed(0)}%</td>
                {/* Three states, not two. The quote is two on chain reads per
                    leg and lands about a second after the table does, and a
                    dash in that gap reads as "you would receive nothing" on
                    the one column a buyer is actually looking at. */}
                <td className="n dim">
                  {amountIn === 0n
                    ? 'enter a spend'
                    : quotes?.[i]
                      ? Number(formatUnits(quotes[i]!, 18)).toFixed(4)
                      : 'pricing'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="card" style={{ marginTop: 22, borderColor: 'var(--line-2)' }}>
          <div className="buybar">
            <div>
              <label>Spend, USDG</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </div>
            <div>
              <label>Slippage</label>
              <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
                <option value={50}>0.5%</option><option value={100}>1%</option>
                <option value={300}>3%</option><option value={1000}>10%</option>
              </select>
            </div>
            <button className="btn" disabled={!isConnected || !!busy || amountIn === 0n} onClick={buy}>
              {busy ?? (isConnected ? 'Buy' : 'Connect wallet')}
            </button>
          </div>
          <div className="notice" style={{ marginTop: 14 }}>
            Every holding goes <b>straight to your wallet</b>. If any leg cannot fill above its minimum the
            whole purchase is cancelled rather than leaving you a partial basket.
          </div>
          {error && <div className="notice bad" style={{ marginTop: 10 }}>{error}</div>}
          {done && <div className="notice" style={{ marginTop: 10, borderLeftColor: 'var(--accent)' }}><b>Bought.</b></div>}
        </div>

        <h2 style={{ marginTop: 34 }}>Recent buys</h2>
        {(activity?.buys ?? []).length === 0 && <div className="card dim">No buys yet.</div>}
        {(activity?.buys ?? []).length > 0 && (
          <table>
            <thead><tr><th>Buyer</th><th className="n">Amount</th><th className="n">Creator fee</th><th className="n">When</th></tr></thead>
            <tbody>
              {activity!.buys.map((b) => (
                <tr key={b.tx + b.buyer}>
                  <td className="num">{short(b.buyer)}</td>
                  <td className="n num">{usdg(b.amount_in)}</td>
                  <td className="n num up">{usdgPrecise(b.creator_fee)}</td>
                  <td className="n dim small">{ago(b.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

/** Everything one person has launched, and what it has paid them. */
export function CreatorPage({ who }: { who: string }) {
  const { data } = useApi<{ address: string; launched: number; feesEarned: number; indexes: Motif[] }>(
    `/v1/creators/${who}`, 10_000,
  )
  if (!data) return <section className="view"><div className="wrap"><div className="card dim">Loading…</div></div></section>

  return (
    <section className="view">
      <div className="wrap">
        <a href="/explore" className="dim small">&larr; All motifs</a>
        <h1 style={{ fontSize: 30, marginTop: 14 }} className="num">{short(data.address)}</h1>
        <div className="strip">
          <div><div className="k">Motifs launched</div><div className="v">{data.launched}</div></div>
          <div><div className="k">Fees earned</div><div className="v up">{usdg(data.feesEarned)}</div></div>
          <div><div className="k">Total volume</div>
            <div className="v">{usdg(data.indexes.reduce((n, m) => n + Number(m.volume ?? 0), 0))}</div></div>
          <div><div className="k">Holders reached</div>
            <div className="v">{data.indexes.reduce((n, m) => n + Number(m.buys ?? 0), 0)}</div></div>
        </div>

        <table style={{ marginTop: 24 }}>
          <thead><tr><th>Motif</th><th className="n">Volume</th><th className="n">Earned</th><th className="n">Launched</th></tr></thead>
          <tbody>
            {data.indexes.map((m) => (
              <tr key={m.id}>
                <td><a className="up" href={`/m/${m.id}`}>{m.name}</a> <span className="num dim small">{m.symbol}</span></td>
                <td className="n num">{usdg(m.volume)}</td>
                <td className="n num up">{usdg(m.fees)}</td>
                <td className="n dim small">{ago(m.ts)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
