import { ImageResponse } from 'next/og'
import { fetchForMeta, pictureForCard, symbolFor } from '@/lib/meta'
import { SITE_MARK } from '@/lib/mark'
import type { Curve } from '@/lib/api'

export const alt = 'A basket token on Motif'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * The card a shared basket token link shows.
 *
 * The same rules as a motif's card, drawn from live data and claiming nothing
 * the api has not said. What is different is the one number worth putting on
 * it, and it changes at graduation: before, how close the raise is; after,
 * that the thing is backed and redeemable.
 *
 * A token is the half of this product people actually share a link to, so this
 * mattering is not a stylistic point. Deleting this file removes the image and
 * leaves the title and description working, which is why the metadata in
 * `page.tsx` does not depend on it.
 */
export default async function Image({ params }: { params: { address: string } }) {
  const data = await fetchForMeta<{ curve: Curve }>(`/v1/curves/${params.address}`)
  const c = data?.curve
  // Fetched rather than linked, and null on anything unusual: a card without
  // the picture is a good card, a card that failed to render is no card.
  const pic = await pictureForCard(c?.image)

  const bg = '#0b0d10'
  const dim = '#8b93a3'
  const text = '#e9ecf1'
  const accent = '#ccff33'
  const warm = '#ff8a3d'

  const progress = c ? Math.min(c.progressBps / 100, 100) : 0
  const money = (raw: string | undefined) =>
    raw === undefined ? '' : '$' + (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: bg,
          // 56 rather than 72, and the picture is 140 rather than 190. A
          // 1200x630 card has a fixed height and the picture is the tallest
          // thing in the top row, so adding it pushed the row underneath off
          // the bottom: rendered with a seven leg motif, the level and the
          // return were both cut in half. Measured after, not assumed.
          padding: 56,
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* The real mark rather than three rectangles pretending to be it.
                Its legs are cut on a slant and no arrangement of boxes lands
                that, which this project already learned twice on the site
                itself. The bars stay only as the fallback for a logo that
                could not be read at all. */}
            {SITE_MARK ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={SITE_MARK} alt="" width={54} height={54} />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ width: 64, height: 10, background: accent, borderRadius: 2 }} />
                <div style={{ width: 40, height: 10, background: text, borderRadius: 2 }} />
                <div style={{ width: 22, height: 10, background: '#5b6273', borderRadius: 2 }} />
              </div>
            )}
            <div style={{ color: dim, fontSize: 26, letterSpacing: 1 }}>MOTIF · BASKET TOKEN</div>
          </div>

          {/* The creator's own picture, which until now never left the grid. */}
          {pic && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={pic}
              alt=""
              width={140}
              height={140}
              style={{ borderRadius: 16, objectFit: 'cover', border: '1px solid #232833' }}
            />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ color: text, fontSize: 78, lineHeight: 1.05 }}>
            {c?.name ?? 'A basket token'}
          </div>
          <div style={{ color: dim, fontSize: 34, marginTop: 14 }}>
            {c?.symbol ?? 'Backed by real tokenised equities'}
          </div>

          {c && (
            <div style={{ display: 'flex', gap: 14, marginTop: 34, flexWrap: 'wrap' }}>
              {c.legs.slice(0, 6).map((l) => (
                <div
                  key={l.token}
                  style={{
                    display: 'flex',
                    color: text,
                    fontSize: 28,
                    border: '1px solid #232833',
                    borderRadius: 8,
                    padding: '10px 18px',
                  }}
                >
                  {`${(l.weight_bps / 100).toFixed(0)}% ${symbolFor(l.token)}`}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {c && !c.graduated && (
            <div style={{ display: 'flex', width: '100%', height: 10, background: '#1f242e', borderRadius: 6 }}>
              <div style={{ display: 'flex', width: `${progress}%`, height: 10, background: accent, borderRadius: 6 }} />
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ color: dim, fontSize: 22 }}>
                {!c ? 'motif.fund' : c.graduated ? 'Raised, and spent on stock' : 'Raised so far'}
              </div>
              {/* The raise, not the backing. Most of the raise buys stock and
                  the rest seeds the pool, so calling the threshold "stock in
                  the vault" overstates it, on the one surface where nobody
                  can click through to check. */}
              <div style={{ color: text, fontSize: 46 }}>
                {!c
                  ? 'A token with real equities behind it'
                  : `${money(c.raised)}${c.graduated ? '' : ` of ${money(c.threshold)}`}`}
              </div>
            </div>

            {c && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <div style={{ color: dim, fontSize: 22 }}>
                  {c.graduated ? 'Redeemable' : 'On the curve'}
                </div>
                <div style={{ color: c.graduated ? accent : warm, fontSize: 46 }}>
                  {c.graduated ? 'Any time' : `${progress.toFixed(0)}%`}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    ),
    size,
  )
}
