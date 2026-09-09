'use client'

import { useState } from 'react'
import { colorOf } from '@/lib/contracts'

export type ArtLeg = { token: string; weight_bps: number }

/**
 * The top half of a tile, for both grids.
 *
 * @remarks
 * The first version drew the basket itself: a full height stack of bands, one
 * per holding, sized by weight and labelled "SPCX 60%". The claim was that the
 * composition is the artwork and needs no upload. Read on a real grid rather
 * than imagined, that was wrong twice over. Twelve tickers is a small palette
 * and most baskets draw from the same handful, so a page of them was a wall of
 * near identical colour bars; and a tile covered in percentages reads as a
 * chart in a list of charts, which tells a visitor nothing about which one to
 * open. Reported from the live site, twice, as looking bad.
 *
 * So there is one shape now and a picture is simply what fills it. With one,
 * the picture is the tile. Without one, the tile is drawn: a dark ground, two
 * soft washes in the colours of the two largest holdings, and the ticker set
 * large across it, which reads as a mark rather than as a missing image. The
 * angle and the placement are seeded from the launch itself, so two baskets
 * holding the same two tickers still do not come out looking like each other.
 *
 * **The weights never leave.** They are the only thing here that says what the
 * basket actually is, and neither a picture nor a monogram says that. They are
 * the strip along the bottom in both cases, which is where they already were
 * on a tile that had a picture.
 */
export function TileArt({
  image,
  legs,
  symbol,
  seed,
}: {
  image?: string | null
  legs: ArtLeg[]
  symbol?: string | null
  seed: string | number
}) {
  /*
   * The url lives in a log that can never be edited, so one day it points at
   * something that is gone, and a dead `img` renders as an empty frame with a
   * broken glyph in it. That is the grey placeholder arriving by another door.
   * A failed load falls back to the drawn tile, which needs nothing and cannot
   * rot.
   */
  const [broken, setBroken] = useState(false)
  const ordered = [...legs].sort((a, b) => b.weight_bps - a.weight_bps)

  const strip = (
    <div className="tile-art-strip">
      {ordered.map((l) => (
        <span key={l.token} style={{ width: `${l.weight_bps / 100}%`, background: colorOf(l.token) }} />
      ))}
    </div>
  )

  if (image && !broken) {
    return (
      <div className="tile-art-img">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image} alt="" loading="lazy" onError={() => setBroken(true)} />
        {strip}
      </div>
    )
  }

  // A small integer off the launch, so the same basket always draws the same
  // way and two baskets with the same holdings do not.
  let n = 0
  for (const ch of String(seed)) n = (n * 31 + ch.charCodeAt(0)) % 100_000
  const a = colorOf(ordered[0]?.token ?? '')
  const b = colorOf(ordered[1]?.token ?? ordered[0]?.token ?? '')
  const x1 = 12 + (n % 34)
  const y1 = 8 + ((n >> 3) % 26)
  const x2 = 62 + ((n >> 6) % 30)
  const y2 = 66 + ((n >> 9) % 26)

  return (
    <div
      className="tile-art-img tile-art-drawn"
      style={{
        backgroundImage: [
          `radial-gradient(115% 95% at ${x1}% ${y1}%, ${a}7d, ${a}00 64%)`,
          `radial-gradient(105% 85% at ${x2}% ${y2}%, ${b}60, ${b}00 60%)`,
        ].join(','),
      }}
    >
      {symbol ? (
        <span className="tile-mark num" aria-hidden="true">
          {symbol.slice(0, 6)}
        </span>
      ) : null}
      {strip}
    </div>
  )
}
