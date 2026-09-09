'use client'

import { useMemo, useState } from 'react'
import { price as money } from '@/lib/api'

type Point = { at: number; level18: string }

/**
 * A basket token's reading: what it costs, and what it redeems for.
 *
 * `floor18` is null for every reading taken before graduation, because there
 * was no vault holding anything then. Null has to be drawn as absent rather
 * than as zero, which would put a floor line along the bottom of the chart for
 * a token that has nothing behind it at all.
 */
export type PricePoint = { at: number; price18: string; floor18: string | null }

const W = 900
const H = 200
const PAD = 8

/**
 * The level over time, drawn as inline SVG.
 *
 * No chart library. A line and an axis label is a few lines of arithmetic, and
 * a dependency here would be a third of the page weight for something the
 * browser already draws.
 *
 * It refuses to draw a trend from one reading. A chart built on two points
 * looks exactly as confident as one built on a thousand, which is the whole
 * problem with charts.
 */
export function LevelChart({ points, windowLabel }: { points: Point[]; windowLabel?: string }) {
  const [hover, setHover] = useState<number | null>(null)

  const series = useMemo(
    () => [...points].sort((a, b) => a.at - b.at).map((p) => ({ at: p.at, v: Number(p.level18) / 1e18 })),
    [points],
  )

  if (series.length < 3) {
    return (
      <div className="card dim small" style={{ textAlign: 'center', padding: '38px 20px' }}>
        Not enough readings yet to draw a line.
        <div style={{ marginTop: 6 }}>
          {series.length === 0
            ? 'Nothing recorded so far.'
            : `${series.length} reading${series.length === 1 ? '' : 's'} so far.`}
        </div>
      </div>
    )
  }

  const values = series.map((p) => p.v)
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  // A dead flat line should sit in the middle rather than fill the box with
  // noise, so give it a floor of half a percent of range.
  const span = Math.max(hi - lo, Math.max(hi, 1) * 0.005)
  const mid = (hi + lo) / 2
  lo = mid - span / 2
  hi = mid + span / 2

  const t0 = series[0]!.at
  const t1 = series[series.length - 1]!.at
  const spanT = Math.max(1, t1 - t0)

  const x = (at: number) => PAD + ((at - t0) / spanT) * (W - PAD * 2)
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2)

  const line = series.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const area = `${line} L${x(t1).toFixed(1)},${H - PAD} L${x(t0).toFixed(1)},${H - PAD} Z`

  const first = series[0]!.v
  const last = series[series.length - 1]!.v
  const up = last >= first
  const stroke = up ? 'var(--accent)' : 'var(--bad)'
  const shown = hover !== null ? series[hover] : null

  return (
    <div className="chart">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="num" style={{ fontSize: 22 }}>
          {(shown?.v ?? last).toFixed(2)}
          <span className="dim small" style={{ marginLeft: 8 }}>
            {shown ? new Date(shown.at * 1000).toLocaleString() : windowLabel ?? 'level, 100 at launch'}
          </span>
        </div>
        <div className={`num ${up ? 'up' : 'down'}`}>
          {up ? '+' : ''}
          {(((last - first) / first) * 100).toFixed(2)}% over this window
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Level over time">
        <defs>
          <linearGradient id="lvl" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.20" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* the launch line, so a reader can see zero without reading an axis */}
        {100 > lo && 100 < hi && (
          <line x1={PAD} x2={W - PAD} y1={y(100)} y2={y(100)} className="chart-base" />
        )}
        <path d={area} fill="url(#lvl)" />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {shown && <circle cx={x(shown.at)} cy={y(shown.v)} r="3" fill={stroke} vectorEffect="non-scaling-stroke" />}
        <rect
          x="0" y="0" width={W} height={H} fill="transparent"
          onMouseMove={(e) => {
            const box = (e.target as SVGRectElement).getBoundingClientRect()
            const frac = (e.clientX - box.left) / box.width
            setHover(Math.max(0, Math.min(series.length - 1, Math.round(frac * (series.length - 1)))))
          }}
          onMouseLeave={() => setHover(null)}
        />
      </svg>

      <div className="row dim small" style={{ marginTop: 6 }}>
        <span>{new Date(t0 * 1000).toLocaleString()}</span>
        <span>{series.length} readings</span>
        <span>{new Date(t1 * 1000).toLocaleString()}</span>
      </div>
    </div>
  )
}

/**
 * A basket token's price, with the floor drawn underneath it.
 *
 * A separate component from `LevelChart` rather than a flag on it. They share
 * a viewBox and nothing else: a motif's level is one series indexed to 100 and
 * a token's price is two series in dollars, where the second one is the entire
 * point of the product. Folding both into one function would mean four
 * conditionals in every line of the arithmetic to save twenty lines.
 *
 * **The gap between the two lines is the thing to read.** The price can go
 * anywhere; the floor is what the stock in the vault is worth, and redemption
 * is what stops the price going below it. Before graduation there is no floor
 * at all, and those readings are drawn with no lower line rather than with one
 * at zero.
 */
export function PriceChart({ points }: { points: PricePoint[] }) {
  const [hover, setHover] = useState<number | null>(null)

  const series = useMemo(
    () =>
      [...points]
        .sort((a, b) => a.at - b.at)
        .map((p) => ({
          at: p.at,
          v: Number(p.price18) / 1e18,
          floor: p.floor18 === null ? null : Number(p.floor18) / 1e18,
        })),
    [points],
  )

  if (series.length < 3) {
    return (
      <div className="card dim small" style={{ textAlign: 'center', padding: '38px 20px' }}>
        Not enough readings yet to draw a line.
        <div style={{ marginTop: 6 }}>
          {series.length === 0
            ? 'Nothing recorded so far. The price is read once a minute from the moment it launches.'
            : `${series.length} reading${series.length === 1 ? '' : 's'} so far.`}
        </div>
      </div>
    )
  }

  // The floor is part of the range, or a token trading at five times its
  // backing would draw the floor off the bottom of the box and the one number
  // worth seeing would be the one that is not on the chart.
  const values = series.flatMap((p) => (p.floor === null ? [p.v] : [p.v, p.floor]))
  const rawLo = Math.min(...values)
  const rawHi = Math.max(...values)
  const span = Math.max(rawHi - rawLo, Math.max(rawHi, 1e-12) * 0.005)
  // A tenth of the range of air at each end. Without it the floor sits flush on
  // the bottom edge of the box and reads as an axis rather than as a line the
  // price is being compared to, which is the one thing this chart is for.
  const lo = rawLo - span * 0.1
  const hi = rawHi + span * 0.1

  const t0 = series[0]!.at
  const t1 = series[series.length - 1]!.at
  const spanT = Math.max(1, t1 - t0)
  const x = (at: number) => PAD + ((at - t0) / spanT) * (W - PAD * 2)
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2)

  const line = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.v).toFixed(1)}`)
    .join(' ')
  const area = `${line} L${x(t1).toFixed(1)},${H - PAD} L${x(t0).toFixed(1)},${H - PAD} Z`

  // One path per unbroken run of readings that had a floor, so a token that
  // graduated part way through the window gets a line that starts where the
  // vault did rather than one drawn back through a period with no vault.
  const floorRuns: string[] = []
  let run: string[] = []
  for (const p of series) {
    if (p.floor === null) {
      if (run.length > 1) floorRuns.push(run.join(' '))
      run = []
      continue
    }
    run.push(`${run.length === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.floor).toFixed(1)}`)
  }
  if (run.length > 1) floorRuns.push(run.join(' '))

  const first = series[0]!.v
  const last = series[series.length - 1]!.v
  const up = last >= first
  const stroke = up ? 'var(--accent)' : 'var(--bad)'
  const shown = hover !== null ? series[hover] : null
  const at = shown ?? series[series.length - 1]!
  const lastFloor = series[series.length - 1]!.floor

  return (
    <div className="chart">
      <div className="row" style={{ marginBottom: 10 }}>
        <div className="num" style={{ fontSize: 22 }}>
          {money(at.v)}
          <span className="dim small" style={{ marginLeft: 8 }}>
            {shown ? new Date(shown.at * 1000).toLocaleString() : 'price'}
          </span>
        </div>
        <div className={`num ${up ? 'up' : 'down'}`}>
          {up ? '+' : ''}
          {(((last - first) / first) * 100).toFixed(2)}% over this window
        </div>
      </div>

      <div className="chart-plot">
      {lastFloor !== null && (
        <span className="chart-floor-l" style={{ top: Math.max(2, y(lastFloor) - 17) }}>
          floor
        </span>
      )}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Price over time">
        <defs>
          <linearGradient id="px" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.20" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#px)" />
        {floorRuns.map((d, i) => (
          <path key={i} d={d} fill="none" className="chart-floor" />
        ))}

        <path d={line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {shown && (
          <circle cx={x(shown.at)} cy={y(shown.v)} r="3" fill={stroke} vectorEffect="non-scaling-stroke" />
        )}
        <rect
          x="0" y="0" width={W} height={H} fill="transparent"
          onMouseMove={(e) => {
            const box = (e.target as SVGRectElement).getBoundingClientRect()
            const frac = (e.clientX - box.left) / box.width
            setHover(Math.max(0, Math.min(series.length - 1, Math.round(frac * (series.length - 1)))))
          }}
          onMouseLeave={() => setHover(null)}
        />
      </svg>
      </div>

      <div className="row dim small" style={{ marginTop: 6 }}>
        <span>{new Date(t0 * 1000).toLocaleString()}</span>
        <span>
          {at.floor === null ? (
            'no floor until it graduates'
          ) : (
            <>
              floor <b className="num">{money(at.floor)}</b>, redeemable
            </>
          )}
        </span>
        <span>{new Date(t1 * 1000).toLocaleString()}</span>
      </div>
    </div>
  )
}
