import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { MotifPage } from '@/components/MotifPage'
import { card, fetchOrStatus, motifDescription } from '@/lib/meta'
import type { Motif } from '@/lib/api'

/**
 * A motif at its own url, which is the thing people actually share.
 *
 * The page still renders and updates client side. This wrapper exists so the
 * title and the card are built on the server where an unfurler can see them: a
 * fragment is never sent to a server, so under the old hash routing every motif
 * link in the world unfurled as the same generic page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const { data: motif } = await fetchOrStatus<Motif>(`/v1/indexes/${id}`)

  // The api being unreachable must not take the page down with it, so this
  // falls back to a card that is thin rather than to an error.
  if (!motif) {
    return card({
      title: `Motif #${id}`,
      description: 'An index of tokenised equities, bought in one transaction.',
      path: `/m/${id}`,
    })
  }

  return card({
    title: `${motif.name} (${motif.symbol})`,
    description: motifDescription(motif),
    path: `/m/${id}`,
  })
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^\d+$/.test(id)) notFound()

  // Only when the api said so. A motif that exists must never be told it does
  // not because the indexer happened to be restarting.
  const { missing } = await fetchOrStatus<Motif>(`/v1/indexes/${id}`)
  if (missing) notFound()

  return <MotifPage id={Number(id)} />
}
