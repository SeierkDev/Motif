import type { Metadata } from 'next'
import { CreatorPage } from '@/components/MotifPage'
import { card, fetchForMeta } from '@/lib/meta'

type CreatorSummary = { launched: number; feesEarned: string }

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>
}): Promise<Metadata> {
  const { address } = await params
  const who = await fetchForMeta<CreatorSummary>(`/v1/creators/${address}`)

  const description = who
    ? `${who.launched} motif${who.launched === 1 ? '' : 's'} published, ${
        '$' + Math.round(Number(who.feesEarned) / 1e6).toLocaleString('en-US')
      } earned in creator fees.`
    : 'Motifs published on Robinhood Chain.'

  return card({ title: `${short(address)}`, description, path: `/c/${address}` })
}

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params
  return <CreatorPage who={address} />
}
