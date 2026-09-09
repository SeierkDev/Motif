import type { Metadata } from 'next'
import { CurvePage } from '@/components/CurvePage'
import { card, curveDescription, fetchOrStatus } from '@/lib/meta'
import { isAddress } from '@/lib/contracts'
import type { Curve } from '@/lib/api'

/**
 * A basket token at its own url, which is the thing people share.
 *
 * Everything on the page itself is read from the curve at this address, so a
 * token nobody has listed still works if you have the address. The card is not:
 * it is built here, on the server, from the api, because an unfurler never runs
 * the page.
 *
 * It used to be generic for every token in the world, on the argument that the
 * name is on chain and fetching it would put an rpc round trip in front of
 * every unfurl. That stopped being true when `/v1/curves/:curve` landed: this
 * is the same one cached call `/m/[id]` already makes, and for a token whose
 * whole distribution is somebody pasting a link, a card that says "A basket
 * token" for all of them is the difference between a share and a shrug.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<Metadata> {
  const { address } = await params
  const { data } = await fetchOrStatus<{ curve: Curve }>(`/v1/curves/${address}`)
  const c = data?.curve

  // An api that is unreachable, or a token it has not indexed yet, falls back
  // to a thin card rather than to an error. The page below still works.
  if (!c) {
    return card({
      title: 'A basket token',
      description:
        'Bought on a bonding curve, backed by real tokenised equities, redeemable for its share of them at any time.',
      path: `/t/${address}`,
    })
  }

  return card({
    title: `${c.name} (${c.symbol})`,
    description: curveDescription(c),
    path: `/t/${address}`,
  })
}

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params

  if (!isAddress(address)) {
    return (
      // `.view` sets `padding: 40px 0 90px`, which zeroes the horizontal padding
      // `.wrap` gives, so both on one element has no gutter at all. Every other
      // page nests them, and at a narrow viewport this one was flush to the edge.
      <section className="view">
        <div className="wrap">
          <h1>Not an address</h1>
          <p className="lede">A basket token url is /t/ followed by the curve&rsquo;s contract address.</p>
        </div>
      </section>
    )
  }

  return <CurvePage curve={address} />
}
