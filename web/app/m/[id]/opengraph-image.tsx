import { ImageResponse } from 'next/og'
import { fetchForMeta, pictureForCard, symbolFor } from '@/lib/meta'
import { SITE_MARK } from '@/lib/mark'
import type { Motif } from '@/lib/api'

export const alt = 'A motif on Motif'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

/**
 * The card a shared motif link shows.
 *
 * Drawn from live data rather than decorated: the name, the ticker, the actual
 * weights and the actual return. There is no artwork here on purpose, and
 * nothing on the card is a claim the api has not made. A motif with no reading
 * yet shows its holdings and no performance line, rather than a confident zero.
 *
 * Deleting this file removes the image and leaves the title and description
 * cards working, which is the whole reason the metadata does not depend on it.
 */
export default async function Image({ params }: { params: { id: string } }) {
  const motif = await fetchForMeta<Motif>(`/v1/indexes/${params.id}`)
  // Fetched rather than linked, and null on anything unusual: a card without
  // the picture is a good card, a card that failed to render is no card.
  const pic = await pictureForCard(motif?.image)

  const bg = '#0b0d10'
  const dim = '#8b93a3'
  const text = '#e9ecf1'
  const accent = '#ccff33'

  const bps = motif?.performance?.changeBps?.inception ?? null
  const level = motif?.performance?.level ? Number(motif.performance.level) / 1e18 : null

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
            <div style={{ color: dim, fontSize: 26, letterSpacing: 1 }}>MOTIF</div>
          </div>

          {/* The creator's own picture, which until now never left the grid: it
              was on the tile and on nothing anybody could share. */}
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
            {motif?.name ?? `Motif #${params.id}`}
          </div>
          <div style={{ color: dim, fontSize: 34, marginTop: 14 }}>
            {motif?.symbol ?? 'An index of tokenised equities'}
          </div>

          {motif && (
            <div style={{ display: 'flex', gap: 14, marginTop: 34, flexWrap: 'wrap' }}>
              {motif.legs.slice(0, 5).map((l) => (
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

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ color: dim, fontSize: 22 }}>
              {level === null ? 'Not priced yet' : 'Level, 100 at launch'}
            </div>
            <div style={{ color: text, fontSize: 46 }}>
              {level === null ? 'motif.fund' : level.toFixed(2)}
            </div>
          </div>

          {bps !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
              <div style={{ color: dim, fontSize: 22 }}>Since launch</div>
              {/* Zero is neither up nor down, and colouring it green reads as a
                  win. Same rule the site uses everywhere else. */}
              <div style={{ color: bps === 0 ? dim : bps > 0 ? accent : '#ff5f56', fontSize: 46 }}>
                {`${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`}
              </div>
            </div>
          )}
        </div>
      </div>
    ),
    size,
  )
}
