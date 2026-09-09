import type { Metadata } from 'next'
import type { Curve, Motif } from './api'
import { numOrElse, origin } from './env'

/**
 * Where this deployment lives, for absolute urls.
 *
 * Open Graph tags cannot use a relative url. A card with a relative image is a
 * card with no image, and it fails silently: the page still renders, the link
 * still works, and the unfurl is just blank forever.
 */
/**
 * Where this deployment lives, as an absolute url with a scheme.
 *
 * @dev **A bare domain is accepted and fixed rather than allowed to fail the
 *      build.** `layout.tsx` passes this to `new URL()` for `metadataBase`, and
 *      `new URL('example.up.railway.app')` is not a relative url, it is a
 *      TypeError. That threw while Next was collecting page data, which killed
 *      `next build` and failed the whole image build, and the message named the
 *      page rather than the variable.
 *
 *      The natural thing to paste on Railway is `${RAILWAY_PUBLIC_DOMAIN}`,
 *      which expands to the host with no scheme, so the wrong value is the one
 *      the platform hands you. A missing `https://` is unambiguous, so it is
 *      added rather than reported: there is no other scheme a public site would
 *      have meant, and refusing to build over it helps nobody.
 */
export const SITE = origin(process.env.NEXT_PUBLIC_SITE_URL, 'https://motif.fund')

const API = origin(process.env.NEXT_PUBLIC_API, 'http://127.0.0.1:8787')

/**
 * How long a metadata read may take before it is given up on.
 *
 * @dev **`fetch` has no timeout of its own, and a hang is not an error.** Both
 *      helpers below return null on failure, which reads as covering every
 *      case and does not: `catch` fires on a refused connection or a dns
 *      failure, and never on a socket that is accepted and then held open. So
 *      an api that is reachable but wedged did not produce a generic card, it
 *      produced a request that never finished.
 *
 *      That took down Railway builds repeatedly. `next build` prerendered
 *      /sitemap.xml, which calls the api, and the api is a separate service
 *      that is not necessarily answering while the site is being built. Next
 *      allows a page 60 seconds to generate, tried three times, and failed the
 *      whole image build. The triggering commit was irrelevant every time,
 *      which is the tell: it was the environment, not the diff.
 *
 *      It is worse at request time than at build time, and that half was
 *      invisible because the build failed first. Every card on the site is
 *      built by one of these two calls, so a wedged api meant a page that never
 *      rendered at all rather than one that rendered without a card, which is
 *      the exact opposite of what the comments below promise.
 *
 *      Well under Next's 60 second page budget on purpose, so a slow api costs
 *      a generic card rather than a failed render.
 */
const TIMEOUT_MS = numOrElse(process.env.NEXT_PUBLIC_META_TIMEOUT_MS, 5000)

/**
 * One fetch, bounded in time, with the response handed back untouched.
 *
 * Kept separate from the two helpers so the timeout cannot be applied to one
 * and forgotten on the other, which is how the sitemap and the card routes
 * came to differ in the first place.
 */
async function get(path: string): Promise<Response | null> {
  try {
    return await fetch(`${API}${path}`, {
      next: { revalidate: 30 },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // A timeout arrives here as an AbortError, alongside the refusals and dns
    // failures this always caught. All of them mean the same thing to a caller:
    // no answer, carry on without one.
    return null
  }
}

/**
 * Read the api from the server, for metadata only.
 *
 * Returns null rather than throwing on any failure. A link unfurler asking for
 * a motif while the indexer is restarting should get the generic card, not a
 * 500, and a page that renders its own data client side must not be taken down
 * by the request that only exists to title it.
 */
export async function fetchForMeta<T>(path: string): Promise<T | null> {
  const res = await get(path)
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Like `fetchForMeta`, but says whether the api actually answered.
 *
 * Real routes mean guessable urls, so /m/9999 will get typed. That should be a
 * 404, but only when the api said so: if the indexer is restarting, a real
 * motif must not be told it does not exist and cached as gone.
 */
export async function fetchOrStatus<T>(
  path: string,
): Promise<{ data: T | null; missing: boolean }> {
  const res = await get(path)
  // No answer is not a 404. A timeout must never be cached as "gone", which is
  // the whole reason this helper exists separately from fetchForMeta.
  if (!res) return { data: null, missing: false }
  if (res.status === 404) return { data: null, missing: true }
  if (!res.ok) return { data: null, missing: false }
  try {
    return { data: (await res.json()) as T, missing: false }
  } catch {
    return { data: null, missing: false }
  }
}

const money = (raw: string | number | undefined) =>
  raw === undefined ? null : '$' + Math.round(Number(raw) / 1e6).toLocaleString('en-US')

/** A percentage from basis points. Null stays null: unknown is not flat. */
const pct = (bps: number | null | undefined) =>
  bps === null || bps === undefined ? null : `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`

/**
 * The sentence that shows under a shared link.
 *
 * Built from what the motif actually is rather than a template, and it says
 * nothing it does not know: a motif with no reading yet gets its holdings and
 * no performance claim, instead of a confident "0.00%".
 */
export function motifDescription(m: Motif): string {
  const legs = m.legs
    .map((l) => `${(l.weight_bps / 100).toFixed(0)}% ${symbolFor(l.token)}`)
    .join(', ')

  const parts: string[] = []
  // The creator's own sentence usually ends in a full stop already, and joining
  // on one more gives "60/40.. 60% NVDA" on every card.
  if (m.description) parts.push(m.description.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, ''))
  parts.push(legs)

  const since = pct(m.performance?.changeBps?.inception)
  if (since) parts.push(`${since} since launch`)

  const volume = money(m.volume)
  if (volume && volume !== '$0') parts.push(`${volume} bought`)

  return parts.join('. ') + '.'
}

/* Kept here rather than imported from contracts.ts so metadata generation does
   not pull the whole wagmi client graph onto the server. */
const SYMBOLS: Record<string, string> = {
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
  '0x322f0929c4625ed5bad873c95208d54e1c003b2d': 'TSLA',
  '0x05a3d1cd21d0c88145e82600e62e7e496e0f222b': 'AMC',
  '0x411efb0e7f985935daec3d4c3ebaea0d0ad7d89f': 'SLV',
  '0x92fd66527192e3e61d4ddd13322aa222de86f9b5': 'SGOV',
  '0x117cc2133c37b721f49de2a7a74833232b3b4c0c': 'SPY',
  '0xec262a75e413fafd0df80480274532c79d42da09': 'MSTR',
  '0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8': 'NFLX',
  '0x4e62068525ab11fe768e29dfd00ef909b9803016': 'LULU',
  '0xad25ac6c84d497db898fa1e8387bf6af3532a1c4': 'BABA',
  '0x1d11f0496982706c5e14a514d4e79f2e6bde4516': 'DJT',
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': 'SPCX',
}

/**
 * A basket token's card, in one line.
 *
 * @dev Deliberately says which side of graduation it is on first, because that
 *      is the only thing a reader needs before deciding whether to click: on
 *      one side it is a raise with a progress bar, on the other it is a token
 *      with a floor under it. The rest is the same shape as a motif's.
 */
export function curveDescription(c: Curve): string {
  const legs = c.legs.map((l) => `${(l.weight_bps / 100).toFixed(0)}% ${symbolFor(l.token)}`).join(', ')

  const parts: string[] = []
  if (c.description) parts.push(c.description.trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, ''))
  parts.push(legs)
  parts.push(
    c.graduated
      ? 'Graduated, and redeemable for its share of the stock'
      : `${(c.progressBps / 100).toFixed(0)}% of ${money(c.threshold)} raised`,
  )
  return parts.join('. ') + '.'
}

export const symbolFor = (addr: string) =>
  SYMBOLS[addr.toLowerCase()] ?? `${addr.slice(0, 6)}...`

/** One place that builds a card, so no route can forget half the tags. */
export function card(opts: {
  title: string
  description: string
  path: string
  image?: string
}): Metadata {
  const url = `${SITE}${opts.path}`
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: url },
    openGraph: {
      type: 'website',
      siteName: 'Motif',
      title: opts.title,
      description: opts.description,
      url,
      ...(opts.image ? { images: [{ url: opts.image, width: 1200, height: 630 }] } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: opts.title,
      description: opts.description,
      ...(opts.image ? { images: [opts.image] } : {}),
    },
  }
}

/**
 * A creator's picture, as bytes a link card can actually draw.
 *
 * @remarks
 * The card is rendered on the server by satori, which cannot lay out a picture
 * it has not got. Handing it the url and letting it fetch would put an
 * unbounded request from a stranger's host in the middle of rendering a page,
 * which is the exact failure `fetchForMeta` exists to avoid: a socket that is
 * accepted and never answered is not an error and no `catch` fires. So it is
 * fetched here, under the same timeout as everything else in this file, and
 * handed over as bytes or not at all.
 *
 * Null on anything unusual, and every branch of that is deliberate rather than
 * defensive noise. The card without a picture is a good card; a card that
 * failed to render is no card at all, and a link with no preview is worse than
 * a link with a plain one.
 *
 * `ipfs://` is not resolved. Doing it means picking a gateway, which is a
 * deployment decision nobody has made, and guessing one puts a third party in
 * the path of every shared link. Those launches get the drawn card instead.
 */
const CARD_IMAGE_MAX = 2_000_000

export async function pictureForCard(url: string | null | undefined): Promise<string | null> {
  if (!url || !url.startsWith('https://')) return null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null

    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!type.startsWith('image/')) return null

    // A length header is a hint rather than a promise, so the bytes are counted
    // too. Either one over the cap drops the picture: a card is not worth
    // holding an unbounded body in memory for.
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > CARD_IMAGE_MAX) return null

    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > CARD_IMAGE_MAX) return null

    return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return null
  }
}
