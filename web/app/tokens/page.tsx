import type { Metadata } from 'next'
import { Tokens } from '@/components/Tokens'
import { card } from '@/lib/meta'

export const metadata: Metadata = card({
  title: 'Basket tokens',
  description:
    'Bought on a curve, backed by real tokenised equities, redeemable for a share of them at any time.',
  path: '/tokens',
})

export default function Page() {
  return <Tokens />
}
