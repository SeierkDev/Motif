import type { MetadataRoute } from 'next'
import { SITE, fetchForMeta } from '@/lib/meta'
import type { Motif } from '@/lib/api'

/**
 * Generated per request, never at build time.
 *
 * @dev Two separate reasons, and either one on its own is enough.
 *
 *      It is wrong to prerender. This lists one entry per motif and per basket
 *      token, so a sitemap baked at build time is frozen at whatever existed
 *      when the image was built, and a launchpad that lists nothing new is a
 *      launchpad search never finds. There is no build to trigger when
 *      somebody launches a motif.
 *
 *      And it cannot be prerendered reliably. The api is a separate service on
 *      a separate host, and nothing says it is answering while the site is
 *      being built. `next build` gives a page 60 seconds, tried three times,
 *      and then fails the whole image build, which is what repeatedly killed
 *      the Railway deploy regardless of what the commit changed. The timeout
 *      in `fetchForMeta` makes that survivable; this makes it not happen.
 */
export const dynamic = 'force-dynamic'

/**
 * Every page worth finding, including one entry per motif.
 *
 * The point of moving off hash routing was that a crawler cannot see a
 * fragment. Listing the motifs here is the other half of that: without it a
 * crawler still only ever finds the pages linked from the front door.
 *
 * `lastModified` comes from the last buy rather than the launch, so a motif
 * that is still being traded reads as current.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const fixed = ['', '/explore', '/tokens', '/tokens/new', '/launch', '/orders', '/how', '/proof'].map((path) => ({
    url: `${SITE}${path}`,
    changeFrequency: 'daily' as const,
    priority: path === '' ? 1 : 0.7,
  }))

  /*
   * Both reads at once, not one after the other.
   *
   * They do not depend on each other, and each is bounded by the same timeout,
   * so running them in sequence means a wedged api costs two timeouts rather
   * than one. Measured against an api that accepts the connection and never
   * answers: 10.1s sequential, 5.1s in parallel, for the same seven urls.
   */
  const [board, tokens] = await Promise.all([
    fetchForMeta<{ indexes: Motif[] }>('/v1/leaderboard?by=volume&limit=500'),
    fetchForMeta<{ curves: { curve: string; ts: number }[] }>('/v1/curves?limit=200'),
  ])

  const motifs = (board?.indexes ?? []).map((m) => ({
    url: `${SITE}/m/${m.id}`,
    lastModified: new Date((m.lastBuyTs || m.ts || 0) * 1000),
    changeFrequency: 'hourly' as const,
    priority: 0.9,
  }))

  const creators = [...new Set((board?.indexes ?? []).map((m) => m.creator))].map((who) => ({
    url: `${SITE}/c/${who}`,
    changeFrequency: 'daily' as const,
    priority: 0.5,
  }))

  /*
   * One entry per basket token, for the same reason there is one per motif: a
   * crawler only ever finds what is linked from the front door, and a token
   * page is exactly the sort of thing somebody shares a link to. Without this
   * the whole tokenised half of the site was invisible to search, which is the
   * problem moving off hash routing was supposed to solve.
   */
  const curves = (tokens?.curves ?? []).map((c) => ({
    url: `${SITE}/t/${c.curve}`,
    lastModified: new Date((c.ts || 0) * 1000),
    changeFrequency: 'hourly' as const,
    priority: 0.9,
  }))

  return [...fixed, ...motifs, ...creators, ...curves]
}
