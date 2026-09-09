'use client'

import { useState } from 'react'
import { useReveal } from '@/lib/reveal'
import Link from 'next/link'
import { symbolOf } from '@/lib/contracts'
import { TileArt } from '@/components/TileArt'
import { useApi, useStream, usdg, short, ago, type Curve } from '@/lib/api'

/**
 * A basket token as a tile.
 *
 * The same artwork as a motif tile, drawn by the same component, so a reader
 * moving between the two grids is not learning a second tile. What is added is
 * the one number somebody is actually deciding on, which is different on each
 * side of graduation. Before it, how close the raise is. After it, that the
 * thing is backed and redeemable, which is the whole reason to prefer this to a
 * launchpad whose floor is zero.
 */
function Tile({ c }: { c: Curve }) {
  const progress = Math.min(c.progressBps / 100, 100)

  return (
    <Link className="tile" href={`/t/${c.curve}`}>
      <TileArt image={c.image} legs={c.legs ?? []} symbol={c.symbol} seed={c.curve} />

      <div className="tile-body">
        {/* Same two line shape as a motif tile, for the same reason: see the
            comment on the one in Explore.tsx. */}
        <div className="tile-top">
          <div className="tile-name">{c.name || 'Basket token'}</div>
          <div className="tile-sub">
            <span className="num dim small">{c.symbol}</span>
            <span className={`num tile-ret ${c.graduated ? 'up' : 'warm'}`}>
              {c.graduated ? 'Backed' : `${progress.toFixed(0)}%`}
            </span>
          </div>
        </div>

        {!c.graduated && (
          <div className="raisebar" aria-label={`${progress.toFixed(0)} percent raised`}>
            <div className="raisebar-fill" style={{ width: `${progress}%` }} />
          </div>
        )}

        <div className="tile-nums">
          {c.graduated ? (
            <>
              <span>
                {/* What it actually raised, not what it was aiming at. They are
                    not the same number: a curve can close a hair over its
                    threshold, and the corrective swap at graduation can add to
                    it. Labelling the target "raised" is a small lie on the one
                    tile where the number is final. */}
                <b className="num">{usdg(c.raised)}</b> raised
              </span>
              <span>redeemable</span>
            </>
          ) : (
            <>
              <span>
                <b className="num">{usdg(c.raised)}</b> of {usdg(c.threshold)}
              </span>
              <span>on the curve</span>
            </>
          )}
        </div>

        <div className="tile-foot">
          <span className="num">{short(c.creator)}</span>
          <span>{ago(c.ts)}</span>
        </div>
      </div>
    </Link>
  )
}

/**
 * Every basket token, which is the half of the launchpad that has a floor.
 *
 * Separate from `/explore` rather than mixed into it. A motif and a basket
 * token are bought differently, held differently and exited differently, and a
 * grid that interleaved them would have to explain which was which on every
 * tile. Two grids explain it once, at the top.
 */
export function Tokens() {
  const { data, error } = useApi<{ curves: Curve[] }>('/v1/curves?limit=200', 10_000)
  const curves = data?.curves ?? []

  /**
   * A launch that happens while somebody is looking at this page.
   *
   * @dev The indexer has emitted a `curve` event on the websocket since the
   *      factory landed and nothing listened for it, so a new basket token took
   *      up to the ten second poll to appear on the one page whose entire job
   *      is listing them. `/explore` has had this since it shipped; this is the
   *      same feed, counted rather than rendered, because the grid below is
   *      already the list and a second one above it would say it twice.
   */
  const { events, live } = useStream(12)
  const launches = events.filter((e) => e.kind === 'curve')
  const unseen = launches.filter((e) => !curves.some((c) => c.curve === e.curve))

  /* Rendered a page at a time. This grid had no filters and no sort, so the
     reset key is the length: the only thing that changes which rows exist here
     is the list itself growing. */
  const { shown, sentinel, done } = useReveal(curves, String(curves.length))

  return (
    <section className="view">
      <div className="wrap">
        <div className="browsehead">
          <h1 style={{ margin: 0 }}>Basket tokens</h1>
          <Link className="btn" href="/tokens/new">
            Launch one
          </Link>
        </div>
        <p className="lede">
          Bought on a curve, then backed by real stock in a vault any holder can redeem from at any time. The
          upside is whatever attention gives it. The floor is what the stock is worth, which is not the same
          as what you paid: a token graduates trading well above its backing, so buying in the pool means
          buying above the floor, and nothing here stops the price falling to it.
        </p>

        {live && unseen.length > 0 && (
          <div className="live" style={{ marginTop: 20, marginBottom: 0 }}>
            <span className="dot on" />
            <span className="live-l">Live</span>
            <div className="live-items">
              <span className="live-item">
                {unseen.length === 1
                  ? `${unseen[0]!.name || 'A basket token'} just launched`
                  : `${unseen.length} basket tokens just launched`}
                , appearing here on the next refresh.
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="notice" style={{ marginTop: 24 }}>
            The api is unreachable, so this list is empty rather than wrong.
          </div>
        )}

        {!error && curves.length === 0 && (
          <div className="notice" style={{ marginTop: 24 }}>
            Nothing has launched yet. A basket token appears here the moment somebody launches one, and the
            page for it works from its address even before that.
          </div>
        )}

        {curves.length > 0 && (
          <>
          <div className="grid5" style={{ marginTop: 28 }}>
            {shown.map((c) => (
              <Tile key={c.curve} c={c} />
            ))}
          </div>
          {!done && <div ref={sentinel} className="sentinel" aria-hidden="true" />}
          </>
        )}
      </div>
    </section>
  )
}
