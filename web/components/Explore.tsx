'use client'

import { useEffect, useMemo, useState } from 'react'
import { useReveal } from '@/lib/reveal'
import Link from 'next/link'
import { symbolOf, tokenList, colorOf } from '@/lib/contracts'
import { TileArt } from '@/components/TileArt'
import {
  useApi,
  usdg,
  short,
  ago,
  pct,
  tone,
  levelOf,
  type Motif,
} from '@/lib/api'

/**
 * What this is, for somebody who has never heard of it.
 *
 * CLAUDE.md records that the home page is the grid rather than a pitch, and
 * that is right: a launchpad's front door is its inventory. It assumes there is
 * inventory. With nothing launched the front door was a search box for
 * searching nothing, five sort tabs, twelve ticker filters and a void, and the
 * word "motif" appeared six times without once being defined. The only
 * sentence saying you receive the real stock was in the footer, in dim grey,
 * below the fold at every width.
 *
 * It used to yield once there was inventory: full hero on an empty site, one
 * line above the grid on a populated one. That is off. The pitch is the first
 * thing a stranger needs whether or not there are eighteen motifs under it, and
 * collapsing it the moment the site started working meant the only version
 * anybody would see in practice was the short one.
 */
function Intro() {
  /*
   * The numbers sit beside the copy, and on a phone the panel is hidden in CSS
   * rather than here, because that is a layout decision and it belongs with the
   * breakpoint that stacks the two columns.
   */
  return (
    <div className="intro">
      <div className="intro-copy">
        <h1>A basket of tokenised stocks, bought in one transaction.</h1>
        <p>
          Pick the holdings and the weights, name it, publish it. Anyone can buy
          the whole basket at once, and you earn a fee on every purchase for as
          long as it exists.
        </p>
        <p>
          {/* The claim the competing launchpads on this chain cannot make, and
              the reason the contracts hold nothing. Stated plainly rather than
              as a slogan. */}
          Buying sends the real stock tokens to your own wallet. There is no
          vault, no share class and nothing to redeem, so there is nothing for
          anyone to take. Selling costs no fee.
        </p>
        <div className="introcta">
          <Link className="btn" href="/launch">Launch a motif</Link>
          <Link className="btn ghost" href="/how">How it works</Link>
        </div>
      </div>

      <HeroStats />
    </div>
  )
}

/**
 * The four numbers, beside the copy rather than buried on /how.
 *
 * @dev The hero was a column of text with roughly 900px of nothing next to it
 *      at 1920, which reads as a page that failed to load. This is where every
 *      launchpad on this chain puts its numbers and it is the right place for
 *      them: on /how almost nobody clicked through to see them.
 *
 *      `usdg` for the money because it is a decimal string, not a number:
 *      above 2^53 a double loses the low bits, which is why the api carries it
 *      as a string in the first place.
 *
 *      A dash rather than a zero while the api has not answered, because
 *      unknown is not zero. Once it answers, a real zero is shown as zero.
 */
type Stats = {
  indexes: number
  creators: number
  curves: number
  graduated: number
  volumeIn: string
  raisedOnCurves: string
}

function HeroStats() {
  const { data: s } = useApi<Stats>('/v1/stats', 15_000)
  const bought = s ? usdg(String(BigInt(s.volumeIn) + BigInt(s.raisedOnCurves))) : null

  /*
   * "Bought and raised", which is what the number is, and not the neighbouring
   * launchpad's "bought into stocks", which is what it is not.
   *
   * The figure is volumeIn plus raisedOnCurves. The first half did buy stock:
   * a motif buy spends usdg on the legs in the same transaction. The second
   * half has not: a curve holds the raise until it graduates, and only then
   * does it buy anything. Calling the sum "bought into stocks" claims of the
   * raise something that has not happened yet, on the one panel whose job is
   * to be checkable.
   */
  const cells: { k: string; v: string; note: string }[] = [
    { k: 'Motifs launched', v: s ? String(s.indexes) : '—', note: 'published on chain' },
    { k: 'Bought and raised', v: bought ?? '—', note: 'through motifs and curves' },
    { k: 'Basket tokens', v: s ? String(s.curves) : '—', note: `${s?.graduated ?? '—'} graduated` },
    { k: 'Creators', v: s ? String(s.creators) : '—', note: 'have published one' },
  ]

  return (
    <div className="herostats">
      {cells.map((c) => (
        <div key={c.k}>
          <div className="k">{c.k}</div>
          <div className="v num">{c.v}</div>
          <div className="n">{c.note}</div>
        </div>
      ))}
    </div>
  )
}

const SORTS = [
  { key: 'volume', label: 'Trending' },
  { key: 'return', label: 'Best performing' },
  { key: 'worst', label: 'Worst' },
  { key: 'fees', label: 'Creator earnings' },
  { key: 'new', label: 'New' },
] as const

/**
 * A motif as a tile.
 *
 * **The weights are the artwork, and a picture does not replace them.** The
 * bands are the only thing on a tile that says what the basket actually holds,
 * which is the thing somebody is deciding about, so with a picture they move to
 * a strip along the bottom rather than going away. Exactly what a basket
 * token's tile already does, so both grids read the same way.
 *
 * The picture was added because the original claim did not survive contact with
 * a real grid. Bands alone are honest and they are also monotonous: twelve
 * tickers is a small palette, most baskets draw from the same handful of them,
 * and a page of near identical colour bars tells a visitor nothing about which
 * one to open. A picture is the only thing that distinguishes two baskets
 * holding the same things in different proportions at a glance.
 *
 * Nothing is required, and a launch without one is not a lesser tile: the art
 * is drawn instead. `TileArt` holds both cases and the reasoning behind them.
 */
function Tile({ m }: { m: Motif }) {
  return (
    <Link className="tile" href={`/m/${m.id}`}>
      <TileArt image={m.image} legs={m.legs} symbol={m.symbol} seed={m.id} />

      <div className="tile-body">
        {/* The name gets the whole width and the return sits on the line
            below, next to the ticker. Side by side the return took a fixed
            column off a tile that is 148px wide inside at 390, and names broke
            mid-word: "Everything" came out as "Everythi ng". Measured at 390
            across twelve, five were breaking. */}
        <div className="tile-top">
          <div className="tile-name">{m.name || `Motif #${m.id}`}</div>
          <div className="tile-sub">
            <span className="num dim small">{m.symbol}</span>
            <span className={`num tile-ret ${tone(m.performance?.changeBps?.inception)}`}>
              {pct(m.performance?.changeBps?.inception)}
            </span>
          </div>
        </div>

        <div className="tile-nums">
          <span>
            <b className="num">{levelOf(m.performance)}</b> level
          </span>
          <span>
            <b className="num">{usdg(m.volume)}</b> bought
          </span>
        </div>

        <div className="tile-foot">
          <span className="num">{short(m.creator)}</span>
          <span>{ago(m.ts)}</span>
        </div>
      </div>
    </Link>
  )
}

/*
 * The live strip is gone.
 *
 * It said "Waiting for the next transaction" on an empty site and listed the
 * last eight events on a busy one, which the grid already shows: sorting by
 * New is the same information, in order, without a second place to look. On a
 * phone it was a whole row above the fold saying nothing.
 *
 * `useStream` itself stays in lib/api: /portfolio and the token page use it.
 */

export function Explore() {
  const [by, setBy] = useState<(typeof SORTS)[number]['key']>('volume')
  const [q, setQ] = useState('')
  const [holding, setHolding] = useState<string[]>([])

  // Read once from the url on mount and write back with replaceState. Done this
  // way rather than with useSearchParams so the page stays static and needs no
  // Suspense boundary, while a filtered view is still a link somebody can send.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const s = p.get('by')
    if (s && SORTS.some((x) => x.key === s)) setBy(s as (typeof SORTS)[number]['key'])
    if (p.get('q')) setQ(p.get('q')!)
    const h = p.get('holding')
    if (h) setHolding(h.split(',').filter(Boolean).map((x) => x.toUpperCase()))
  }, [])

  useEffect(() => {
    const p = new URLSearchParams()
    if (by !== 'volume') p.set('by', by)
    if (q.trim()) p.set('q', q.trim())
    if (holding.length) p.set('holding', holding.join(','))
    const search = p.toString()
    window.history.replaceState(null, '', search ? `?${search}` : window.location.pathname)
  }, [by, q, holding])

  const { data, error } = useApi<{ indexes: Motif[] }>(`/v1/leaderboard?by=${by}&limit=200`, 8000)
  const all = useMemo(() => data?.indexes ?? [], [data])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return all.filter((m) => {
      // Every selected ticker has to be in it. Narrowing by adding is what a
      // row of toggles implies, and "any of these" makes the second click widen
      // the results, which reads as broken.
      if (holding.length) {
        const syms = m.legs.map((l) => symbolOf(l.token).toUpperCase())
        if (!holding.every((h) => syms.includes(h))) return false
      }
      if (!needle) return true
      return (
        m.name.toLowerCase().includes(needle) ||
        m.symbol.toLowerCase().includes(needle) ||
        m.creator.toLowerCase().includes(needle) ||
        (m.description ?? '').toLowerCase().includes(needle) ||
        m.legs.some((l) => symbolOf(l.token).toLowerCase().includes(needle))
      )
    })
  }, [all, q, holding])

  const filtered = q.trim().length > 0 || holding.length > 0

  // The sort and both filters, because any of them changes which rows are in
  // the list and the reveal has to start again from the top.
  const { shown, sentinel, done } = useReveal(list, `${by}|${q.trim()}|${holding.join(',')}`)

  /*
   * Loading and empty are different pages, and `data` is null for both, so
   * asking `all.length === 0` on its own would flash the whole intro on every
   * visit before the grid arrived. An error counts as ready: a page that says
   * what the site is beats a blank one while the api is unreachable.
   */
  const ready = data !== null || error !== null
  const bare = ready && all.length === 0 && !filtered

  /*
   * Nothing commits to a layout until the api has answered.
   *
   * `bare` is false while loading, so the first paint used to be the slim
   * intro with the search box, the sort tabs and the ticker filters under it,
   * and then the api came back with nothing and all of that was replaced by
   * the full hero. On a site with no motifs yet that is every refresh: the
   * grid appears, then vanishes, then the headline arrives. Two layouts on one
   * load reads as a page that broke and recovered.
   *
   * Waiting costs a moment of empty space instead. It is the api's own domain
   * and it answers in about a hundred milliseconds, so what a reader sees is
   * the header and then the page, rather than the page twice.
   */
  if (!ready) {
    return (
      <section className="view" style={{ paddingTop: 22 }}>
        <div className="wrap">
          <div className="intro-wait" aria-hidden />
        </div>
      </section>
    )
  }

  return (
    <section className="view" style={{ paddingTop: 22 }}>
      <div className="wrap">
        <Intro />

        {/* A search box and twelve ticker filters for an empty list make a new
            site look like a broken one. They come back the moment there is
            something to sort. */}
        {!bare && (
        <div className="finder">
          <input
            className="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a motif by name, ticker, holding or creator"
            aria-label="Search motifs"
          />
          <Link className="btn" href="/launch">
            Launch a motif
          </Link>
        </div>
        )}

        {!bare && (
        <>
        <div className="browsehead">
          <div className="browsehead-l">
            {/* Still the h1, and still the only one: this block and the full
                intro are mutually exclusive, so exactly one of the two h1s on
                this page ever renders. Demoting it to h2 was measured and left
                a populated page with no h1 at all. */}
            <h1 className="label" style={{ marginBottom: 0 }}>Motifs</h1>
            <span className="count num">{all.length} launched</span>
          </div>
          <div className="tabs">
            {SORTS.map((s) => (
              <button
                key={s.key}
                className={by === s.key ? 'tab on' : 'tab'}
                onClick={() => setBy(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="holdbar">
          <span className="holdbar-l">Holding</span>
          <div className="tabs holdbar-t">
            {tokenList.map((t) => {
              const on = holding.includes(t.symbol.toUpperCase())
              return (
                <button
                  key={t.address}
                  className={`tab${on ? ' on' : ''}`}
                  onClick={() =>
                    setHolding((h) =>
                      on
                        ? h.filter((x) => x !== t.symbol.toUpperCase())
                        : [...h, t.symbol.toUpperCase()],
                    )
                  }
                >
                  {t.symbol}
                </button>
              )
            })}
            {filtered && (
              <button
                className="tab clear"
                onClick={() => {
                  setQ('')
                  setHolding([])
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
        </>
        )}

        {error && <div className="notice bad">Cannot reach the indexer. {error}</div>}

        {filtered && (
          <div className="dim small" style={{ marginBottom: 14 }}>
            {list.length} of {all.length}
            {holding.length > 0 && <> holding {holding.join(' and ')}</>}
            {q.trim() && <> matching &ldquo;{q.trim()}&rdquo;</>}
          </div>
        )}

        {/* When the page is bare the intro already says what to do and offers
            the button, so a second card repeating "be the first" underneath it
            is the same call to action twice. */}
        {list.length === 0 && !error && !bare && (
          <div className="card dim" style={{ marginTop: 12 }}>
            {filtered ? (
              <>Nothing matches that. Try a different ticker, or clear the filters.</>
            ) : (
              <>
                Nothing launched yet.{' '}
                <Link href="/launch" className="up">
                  Be the first.
                </Link>
              </>
            )}
          </div>
        )}

        <div className="grid5">
          {shown.map((m) => (
            <Tile key={m.id} m={m} />
          ))}
        </div>
        {/* Sits below the grid and pulls the next page in before the reader
            reaches it, so the list never visibly stops. */}
        {!done && <div ref={sentinel} className="sentinel" aria-hidden="true" />}
      </div>
    </section>
  )
}
