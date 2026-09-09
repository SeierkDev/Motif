'use client'

import { useCallback, useEffect, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { formatUnits, parseAbi, parseUnits } from 'viem'
import { addresses, ordersAbi, tokenList, symbolOf } from '@/lib/contracts'
import { ago } from '@/lib/api'

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])

/** The canonical Permit2, already deployed on this chain. */
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const
const permit2Abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

/** A year. Long enough to be useful, short enough that a forgotten order lapses. */
const PERMIT_WINDOW = 365 * 24 * 3600

/** Matches the enum in Orders.sol, in declaration order. */
const KINDS = [
  { v: 0, label: 'Limit buy', hint: 'Buy once the price falls to your limit.', buys: true },
  { v: 1, label: 'Limit sell', hint: 'Sell once the price rises to your limit.', buys: false },
  { v: 2, label: 'Stop loss', hint: 'Sell if the price falls to your stop.', buys: false },
  { v: 3, label: 'Trailing stop', hint: 'Sell if it falls a set percentage from its high.', buys: false },
  { v: 4, label: 'TWAP', hint: 'Fill in equal slices on a timer, ignoring price.', buys: true },
] as const

type OnChainOrder = {
  owner: string
  token: `0x${string}`
  fee: number
  kind: number
  buying: boolean
  amount: bigint
  filled: bigint
  trigger: bigint
  trailBps: number
  peak: bigint
  maxSlippageBps: number
  slices: number
  interval: number
  lastFillAt: bigint
  expiry: bigint
  active: boolean
}

const price18 = (p: bigint) => '$' + Number(formatUnits(p, 18)).toFixed(2)

export function OrdersView() {
  const { address, isConnected } = useAccount()
  const client = usePublicClient()
  const { writeContractAsync } = useWriteContract()

  const [kind, setKind] = useState(2) // stop loss: the reason this exists
  const [token, setToken] = useState(tokenList[0]!.address)
  const [amount, setAmount] = useState('1')
  const [triggerPct, setTriggerPct] = useState('-10')
  const [trailBps, setTrailBps] = useState('500')
  const [slices, setSlices] = useState('4')
  const [intervalHours, setIntervalHours] = useState('1')
  const [slippage, setSlippage] = useState(300)

  const [spot, setSpot] = useState<bigint | null>(null)
  const [mine, setMine] = useState<{ id: number; o: OnChainOrder; ready: boolean; why: string }[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const spec = KINDS.find((k) => k.v === kind)!
  const fee = tokenList.find((t) => t.address === token)?.fee ?? 500
  const decimals = spec.buys ? 6 : 18

  /* current price, so a trigger can be expressed as a percentage move */
  useEffect(() => {
    if (!client) return
    let alive = true
    import('@/lib/quote')
      .then(({ poolSpot }) => poolSpot(client, token, fee))
      .then((p) => alive && setSpot(p))
      .catch(() => alive && setSpot(null))
    return () => { alive = false }
  }, [client, token, fee])

  const load = useCallback(async () => {
    if (!client || !address) return
    try {
      const ids = (await client.readContract({
        address: addresses.orders, abi: ordersAbi, functionName: 'ordersOf', args: [address],
      })) as bigint[]
      const rows = await Promise.all(
        ids.map(async (id) => {
          const o = (await client.readContract({
            address: addresses.orders, abi: ordersAbi, functionName: 'get', args: [id],
          })) as unknown as OnChainOrder
          let ready = false
          let why = ''
          try {
            const r = (await client.readContract({
              address: addresses.orders, abi: ordersAbi, functionName: 'ready', args: [id],
            })) as unknown as [boolean, string, bigint]
            ready = r[0]; why = r[1]
          } catch { why = 'cannot be read' }
          return { id: Number(id), o, ready, why }
        }),
      )
      setMine(rows.reverse())
    } catch (e) { setError((e as Error).message.split('\n')[0]!) }
  }, [client, address])

  useEffect(() => { load() }, [load])

  async function place() {
    if (!client || !address || !spot) return
    setError(null); setNote(null)
    try {
      const amt = parseUnits(amount || '0', decimals)
      const src = spec.buys ? addresses.usdg : token

      // Two steps, once per token. The token approval goes to Permit2, and the
      // permission this contract actually uses is granted through Permit2 with
      // a size and an expiry, so a forgotten order does not leave an open ended
      // claim on the wallet.
      const onPermit2 = (await client.readContract({
        address: src, abi: erc20, functionName: 'allowance', args: [address, PERMIT2],
      })) as bigint
      if (onPermit2 < amt) {
        setBusy('Approving Permit2')
        const h = await writeContractAsync({
          address: src, abi: erc20, functionName: 'approve',
          args: [PERMIT2, (1n << 256n) - 1n],
        })
        await client.waitForTransactionReceipt({ hash: h })
      }

      const [permitted, expiry] = (await client.readContract({
        address: PERMIT2, abi: permit2Abi, functionName: 'allowance',
        args: [address, src, addresses.orders],
      })) as [bigint, number, number]
      const now = Math.floor(Date.now() / 1000)
      if (permitted < amt || expiry < now + 60) {
        setBusy('Granting a bounded permission')
        const h = await writeContractAsync({
          address: PERMIT2, abi: permit2Abi, functionName: 'approve',
          args: [src, addresses.orders, amt, now + PERMIT_WINDOW],
        })
        await client.waitForTransactionReceipt({ hash: h })
      }

      // A percentage move off spot is what a person actually thinks in.
      const pct = Number(triggerPct) || 0
      const trigger = kind === 3 || kind === 4 ? 0n : (spot * BigInt(Math.round((100 + pct) * 100))) / 10_000n

      setBusy('Placing')
      const h = await writeContractAsync({
        address: addresses.orders, abi: ordersAbi, functionName: 'place',
        args: [{
          owner: address, token, fee, kind, buying: spec.buys,
          amount: amt, filled: 0n, trigger,
          trailBps: kind === 3 ? Number(trailBps) : 0,
          peak: 0n, maxSlippageBps: slippage,
          slices: kind === 4 ? Number(slices) : 0,
          interval: kind === 4 ? Number(intervalHours) * 3600 : 0,
          lastFillAt: 0n, expiry: 0n, active: true,
        }],
      })
      await client.waitForTransactionReceipt({ hash: h })
      setNote('Order placed. It will fire whenever the condition is met, including at a weekend.')
      await load()
    } catch (e) {
      setError((e as Error).message.split('\n')[0]?.slice(0, 200) ?? 'Failed')
    } finally { setBusy(null) }
  }

  async function cancel(id: number) {
    if (!client) return
    setBusy('Cancelling')
    try {
      const h = await writeContractAsync({
        address: addresses.orders, abi: ordersAbi, functionName: 'cancel', args: [BigInt(id)],
      })
      await client.waitForTransactionReceipt({ hash: h })
      await load()
    } catch (e) { setError((e as Error).message.split('\n')[0]!) } finally { setBusy(null) }
  }

  return (
    <section className="view">
      <div className="wrap">
        <h1 className="label">Orders</h1>
        <p className="lede" style={{ marginTop: 0, marginBottom: 24 }}>
          Stops and limits on tokenised equities. NVDA trades 09:30 to 16:00, the token trades
          constantly, so about seventy percent of every week is time when no broker on earth will
          accept your stop. These read the pool, and the pool never closes.
        </p>

        <div className="card">
          <div className="tabs" style={{ flexWrap: 'wrap', marginBottom: 16 }}>
            {KINDS.map((k) => (
              <button key={k.v} className={kind === k.v ? 'tab on' : 'tab'} onClick={() => setKind(k.v)}>
                {k.label}
              </button>
            ))}
          </div>
          <div className="dim small" style={{ marginBottom: 16 }}>{spec.hint}</div>

          <div className="namebar">
            <div>
              <label>Holding</label>
              <select value={token} onChange={(e) => setToken(e.target.value as `0x${string}`)}>
                {tokenList.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol} · {t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label>{spec.buys ? 'Spend, USDG' : 'Sell, tokens'}</label>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </div>
          </div>

          <div className="buybar" style={{ marginTop: 14 }}>
            {kind === 3 ? (
              <div>
                <label>Trail, basis points below the high</label>
                <input value={trailBps} onChange={(e) => setTrailBps(e.target.value)} inputMode="numeric" />
              </div>
            ) : kind === 4 ? (
              <div>
                <label>Slices</label>
                <input value={slices} onChange={(e) => setSlices(e.target.value)} inputMode="numeric" />
              </div>
            ) : (
              <div>
                <label>Trigger, % from price</label>
                <input value={triggerPct} onChange={(e) => setTriggerPct(e.target.value)} inputMode="decimal" />
              </div>
            )}
            {kind === 4 ? (
              <div>
                <label>Every, hours</label>
                <input value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} inputMode="numeric" />
              </div>
            ) : (
              <div>
                <label>Slippage</label>
                <select value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
                  <option value={100}>1%</option><option value={300}>3%</option>
                  <option value={500}>5%</option><option value={1000}>10%</option>
                </select>
              </div>
            )}
            <button className="btn" disabled={!isConnected || !!busy || !spot} onClick={place}>
              {busy ?? (isConnected ? 'Place order' : 'Connect wallet')}
            </button>
          </div>

          <div className="dim small num" style={{ marginTop: 10 }}>
            {spot ? (
              <>
                {symbolOf(token)} is {price18(spot)}
                {kind !== 3 && kind !== 4 && (
                  <> · this fires at {price18((spot * BigInt(Math.round((100 + (Number(triggerPct) || 0)) * 100))) / 10_000n)}</>
                )}
              </>
            ) : 'Reading the pool…'}
          </div>

          <div className="notice" style={{ marginTop: 16 }}>
            Nothing is escrowed. The order is a <b>Permit2 permission with a size and an expiry</b>,
            not an open ended approval, and the output is paid straight back to you. Cancel it,
            revoke the permit, or simply let it lapse, and it is dead. The
            minimum you accept is anchored to the price you name, not to spot, so pushing the pool to
            trip your stop does not let anyone fill it cheaply. That also means a gap wider than your
            slippage will not fill at all.
          </div>
          {error && <div className="notice bad" style={{ marginTop: 10 }}>{error}</div>}
          {note && <div className="notice" style={{ marginTop: 10, borderLeftColor: 'var(--accent)' }}>{note}</div>}
        </div>

        <h2 style={{ marginTop: 34 }}>Your orders</h2>
        {!isConnected && <div className="card dim">Connect a wallet to see them.</div>}
        {isConnected && mine.length === 0 && <div className="card dim">Nothing placed yet.</div>}
        {mine.length > 0 && (
          <div className="scroll-x">
          <table className="wide-rows">
            <thead>
              <tr>
                <th>Order</th><th className="n">Size</th><th className="n">Trigger</th>
                <th className="n">Filled</th><th>Status</th><th />
              </tr>
            </thead>
            <tbody>
              {mine.map(({ id, o, ready, why }) => (
                <tr key={id}>
                  <td>
                    {KINDS.find((k) => k.v === Number(o.kind))?.label} <b>{symbolOf(o.token)}</b>
                    <div className="dim small">#{id}{o.lastFillAt > 0n && <> · last fill {ago(Number(o.lastFillAt))}</>}</div>
                  </td>
                  <td className="n num">{Number(formatUnits(o.amount, o.buying ? 6 : 18)).toFixed(4)}</td>
                  <td className="n num">{o.trigger > 0n ? price18(o.trigger) : '—'}</td>
                  <td className="n num dim">
                    {o.amount > 0n ? ((Number(o.filled) / Number(o.amount)) * 100).toFixed(0) : 0}%
                  </td>
                  <td className={ready ? 'up small' : 'dim small'}>
                    {!o.active ? 'closed' : ready ? 'ready to fire' : why || 'waiting'}
                  </td>
                  <td className="n">
                    {o.active && (
                      <button className="btn ghost" style={{ padding: '5px 11px', fontSize: 12 }}
                        disabled={!!busy} onClick={() => cancel(id)}>Cancel</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </section>
  )
}
