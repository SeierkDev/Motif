'use client'

import { useEffect, useState } from 'react'
import { origin } from './env'

// Every call becomes a relative path against the site's own origin if this is
// empty *or* has no scheme, and the page then says the indexer is unreachable
// while pointing at itself. Both were real. See `origin` in env.ts.
export const API = origin(process.env.NEXT_PUBLIC_API, 'http://127.0.0.1:8787')

export type Leg = { position: number; token: string; fee: number; weight_bps: number }

export type Performance = {
  level: string | null
  since: number | null
  changeBps: Record<string, number | null>
}

/**
 * A basket token: the curve that sells it and the vault that backs it.
 *
 * `raised`, `threshold`, `sold` and `supply` are decimal strings for the same
 * reason every other amount here is: they are chain amounts and a double loses
 * the low bits above 2^53. `stateAt` is when the moving half was last read, and
 * null means never, which renders as unknown rather than as zero.
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
  /** The creator's picture url from the launch log, or null when there was none. */
  image: string | null
  legCount: number
  legs: Leg[]
  creatorFeeBps: number
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

export type Motif = {
  id: number
  creator: string
  creator_fee_bps: number
  input: string
  leg_count: number
  block: number
  ts: number
  tx: string
  name: string
  symbol: string
  description: string
  /** The creator's picture url from the launch log. Empty string when there
   *  was none, which is every motif published before the router carried the
   *  field and every one a basket token's curve publishes. */
  image: string
  legs: Leg[]
  buys?: number
  /** Decimal strings. BigInt sums on the api side, because a double loses the
   *  low bits above 2^53. */
  volume?: string
  fees?: string
  holders?: number
  lastBuyTs?: number | null
  performance?: Performance | null
}

export type Creator = {
  creator: string
  launched: number
  fees: number
  volume: number
  lastLaunchTs: number
}

export type StreamEvent =
  | { kind: 'hello'; lastBlock: number }
  | { kind: 'index'; id: number; creator: string; name: string; symbol: string; block: number }
  | { kind: 'buy'; id: number; buyer: string; amountIn: string; block: number }
  | { kind: 'sell'; id: number; seller: string; amountOut: string; block: number }
  | { kind: 'rebalance'; holder: string; id: number; driftBefore: number; block: number }
  // A launch through the factory. The api has always sent these; leaving the
  // kind out of the union meant a client narrowing on `kind` could not see one.
  | { kind: 'curve'; curve: string; name: string; symbol: string; creator: string; block: number }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as T
}

export function useApi<T>(path: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return
    let alive = true
    // The error is cleared on a load that works, which it was not: a single
    // failed poll left "the api is unreachable" on the page for as long as it
    // stayed open, above a grid that had since refilled itself. A banner
    // contradicting the content under it is worse than no banner.
    const load = () =>
      get<T>(path)
        .then((d) => {
          if (!alive) return
          setData(d)
          setError(null)
        })
        .catch((e: Error) => alive && setError(e.message))
    load()
    if (!refreshMs) return () => { alive = false }
    const t = setInterval(load, refreshMs)
    return () => { alive = false; clearInterval(t) }
  }, [path, refreshMs])

  return { data, error }
}

/**
 * The live feed, straight off the indexer's websocket.
 *
 * Reconnects on a backoff, because the usual failure is a laptop lid closing
 * and a ticker that has silently stopped is worse than one that says so.
 */
export function useStream(limit = 12) {
  const [events, setEvents] = useState<StreamEvent[]>([])
  const [live, setLive] = useState(false)

  useEffect(() => {
    let closed = false
    let attempt = 0
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      socket = new WebSocket(API.replace(/^http/, 'ws') + '/v1/stream')
      socket.onopen = () => { attempt = 0; setLive(true) }
      socket.onmessage = (m) => {
        try {
          const e = JSON.parse(String(m.data)) as StreamEvent
          if (e.kind === 'hello') return
          setEvents((prev) => [e, ...prev].slice(0, limit))
        } catch { /* a malformed frame is not worth killing the feed for */ }
      }
      socket.onclose = () => {
        setLive(false)
        if (closed) return
        timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** attempt++))
      }
      socket.onerror = () => socket?.close()
    }
    connect()
    return () => { closed = true; if (timer) clearTimeout(timer); socket?.close() }
  }, [limit])

  return { events, live }
}

/* ------------------------------------------------------------------ format */

export const usdg = (raw: number | string | undefined) =>
  raw === undefined ? '—' : '$' + (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })

/* Both bounds, not just the maximum. With only a maximum, $4,875.90 prints as
   "$4,875.9", which reads as a rendering fault rather than as a price. */
export const usdgPrecise = (raw: number | string | undefined) =>
  raw === undefined
    ? '—'
    : '$' +
      (Number(raw) / 1e6).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** "4 minutes ago". Zero means the log carried no timestamp, so say nothing. */
export function ago(ts: number | undefined | null): string {
  if (!ts) return ''
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** A return in basis points, as a percentage string. Null means unknown. */
export const pct = (bps: number | null | undefined) =>
  bps === null || bps === undefined ? '—' : `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`

/** Unknown gets no colour, because dressing "we do not know" as flat is a lie. */
export const tone = (bps: number | null | undefined) =>
  bps === null || bps === undefined ? 'dim' : bps > 0 ? 'up' : bps < 0 ? 'down' : 'dim'

export const levelOf = (p: Performance | null | undefined) =>
  p?.level ? (Number(p.level) / 1e18).toFixed(2) : '—'

/**
 * A price with as many digits as it needs and no more.
 *
 * @dev A basket token opens near $0.000053 and a launchpad token falling a
 *      hundredfold is an ordinary week, so any fixed number of decimal places
 *      is wrong somewhere: two prints `$0.00` for the whole of its life, and
 *      six prints `$0.000000` once it has fallen far enough. Four significant
 *      figures is the same amount of information whatever the size of the
 *      number.
 *
 *      It lives here rather than in a component because two places were
 *      formatting the same price differently: the headline on a token page used
 *      six fixed places and the chart under it used significant figures, so a
 *      token that had fallen showed `$0.000000` in the large number and
 *      `$0.0000005` in the small one, on the same screen.
 */
export function price(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '$0'
  if (v >= 1) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return '$' + v.toFixed(Math.min(12, Math.max(2, 3 - Math.floor(Math.log10(v)))))
}
