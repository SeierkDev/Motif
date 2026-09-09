'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { formatUnits, parseAbi } from 'viem'
import { addresses, basketRouterAbi, symbolOf } from '@/lib/contracts'
import { quoteSell, floorFrom } from '@/lib/quote'
import { usdgPrecise, type Motif } from '@/lib/api'

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

type Row = {
  token: `0x${string}`
  fee: number
  symbol: string
  balance: bigint
  amount: bigint
  quote: bigint | null
  approved: boolean
}

const PERCENTAGES = [25, 50, 100]

/**
 * The way out of a motif, in one transaction.
 *
 * The percentage is of **what the wallet holds of each ticker**, not of some
 * position this app is pretending to track. Leg tokens are ordinary ERC20s, so
 * somebody who bought two motifs containing NVDA has one NVDA balance and not
 * two, and no amount of interface can divide it back up honestly. Selling half
 * sells half of the ticker, and the panel says so rather than implying a
 * bookkeeping that does not exist.
 */
export function SellPanel({ motif, onDone }: { motif: Motif; onDone?: () => void }) {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [percent, setPercent] = useState(100)
  const [tolerance, setTolerance] = useState(100)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!client || !address) return
    setError(null)
    try {
      const next = await Promise.all(
        motif.legs.map(async (leg) => {
          const token = leg.token as `0x${string}`
          const [balance, allowance] = await Promise.all([
            client.readContract({
              address: token, abi: erc20, functionName: 'balanceOf', args: [address],
            }) as Promise<bigint>,
            client.readContract({
              address: token, abi: erc20, functionName: 'allowance',
              args: [address, addresses.basketRouter],
            }) as Promise<bigint>,
          ])
          const amount = (balance * BigInt(percent)) / 100n
          return {
            token,
            fee: leg.fee,
            symbol: symbolOf(leg.token),
            balance,
            amount,
            quote: null,
            approved: allowance >= amount,
          } satisfies Row
        }),
      )
      setRows(next)

      // Quoted after the balances land rather than alongside, so a slow pool
      // read cannot leave the amounts blank.
      const quoted = await Promise.all(
        next.map((r) => quoteSell(client, r.token, r.fee, r.amount).catch(() => null)),
      )
      setRows(next.map((r, i) => ({ ...r, quote: quoted[i] ?? null })))
    } catch (e) {
      setError((e as Error).message.split('\n')[0]!)
    }
  }, [client, address, motif.legs, percent])

  useEffect(() => { load() }, [load])

  const live = (rows ?? []).filter((r) => r.amount > 0n)
  const total = live.reduce((n, r) => n + (r.quote ?? 0n), 0n)
  const unpriced = live.some((r) => r.quote === null)
  const needsApproval = live.filter((r) => !r.approved)

  async function sell() {
    if (!client || !address || !rows) return
    setError(null)
    setDone(null)
    try {
      // One approval per ticker, and only for the ones short of it. A basket
      // with five legs is five signatures the first time and none after.
      for (const row of needsApproval) {
        setBusy(`Approving ${row.symbol}`)
        const h = await writeContractAsync({
          address: row.token, abi: erc20, functionName: 'approve',
          args: [addresses.basketRouter, row.amount],
        })
        await client.waitForTransactionReceipt({ hash: h })
      }

      setBusy('Selling')
      const amounts = rows.map((r) => r.amount)
      // A leg with no quote gets no floor rather than a guessed one. The
      // alternative is inventing a number and calling it protection.
      const minOut = rows.map((r) => (r.quote === null ? 0n : floorFrom(r.quote, tolerance)))
      const h = await writeContractAsync({
        address: addresses.basketRouter, abi: basketRouterAbi, functionName: 'sell',
        args: [BigInt(motif.id), amounts, minOut],
      })
      await client.waitForTransactionReceipt({ hash: h })
      setDone(`Sold. The proceeds are in your wallet.`)
      await load()
      onDone?.()
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e)
      setError(m.split('\n')[0]?.slice(0, 180) ?? 'Failed')
    } finally {
      setBusy(null)
    }
  }

  if (rows === null) return <div className="card dim">Reading your balances…</div>

  if (live.length === 0) {
    return (
      <div className="card dim">
        You hold none of the tickers in this motif, so there is nothing to sell.
      </div>
    )
  }

  return (
    <div className="card" style={{ borderColor: 'var(--line-2)' }}>
      <div className="buybar">
        <div>
          <label>Sell</label>
          <div className="tabs">
            {PERCENTAGES.map((p) => (
              <button
                key={p}
                className={`tab${percent === p ? ' on' : ''}`}
                onClick={() => setPercent(p)}
                disabled={!!busy}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
        <div>
          <label>Slippage</label>
          <select value={tolerance} onChange={(e) => setTolerance(Number(e.target.value))}>
            <option value={50}>0.5%</option>
            <option value={100}>1%</option>
            <option value={300}>3%</option>
            <option value={1000}>10%</option>
          </select>
        </div>
        <button className="btn" disabled={!isConnected || !!busy} onClick={sell}>
          {busy ?? (isConnected ? 'Sell' : 'Connect wallet')}
        </button>
      </div>

      <table style={{ marginTop: 16 }}>
        <thead>
          <tr>
            <th>Ticker</th>
            <th className="n">You hold</th>
            <th className="n">Selling</th>
            <th className="n">Estimated</th>
          </tr>
        </thead>
        <tbody>
          {live.map((r) => (
            <tr key={r.token}>
              <td>{r.symbol}</td>
              <td className="n num dim">{Number(formatUnits(r.balance, 18)).toFixed(4)}</td>
              <td className="n num">{Number(formatUnits(r.amount, 18)).toFixed(4)}</td>
              <td className="n num">{r.quote === null ? '—' : usdgPrecise(r.quote.toString())}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="dim small">Estimated proceeds</span>
        <span className="num" style={{ fontSize: 18 }}>
          {unpriced ? '—' : usdgPrecise(total.toString())}
        </span>
      </div>

      <div className="notice" style={{ marginTop: 14 }}>
        This sells <b>{percent}% of every ticker in this motif that you hold</b>, wherever it came
        from. Tokens are ordinary ERC20s, so if you also hold {live[0]!.symbol} from another motif,
        this sells {percent === 100 ? 'all' : `${percent}%`} of that too. The proceeds go straight to
        your wallet, and there is no fee on the way out.
      </div>

      {needsApproval.length > 0 && (
        <div className="notice" style={{ marginTop: 10 }}>
          {needsApproval.length === 1 ? 'One ticker needs' : `${needsApproval.length} tickers need`}{' '}
          approving first: {needsApproval.map((r) => r.symbol).join(', ')}. Selling will ask for
          those, then the sale.
        </div>
      )}

      {error && <div className="notice bad" style={{ marginTop: 10 }}>{error}</div>}
      {done && (
        <div className="notice" style={{ marginTop: 10, borderLeftColor: 'var(--accent)' }}>
          <b>{done}</b>
        </div>
      )}
    </div>
  )
}
