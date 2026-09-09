import type { Metadata } from 'next'
import { LaunchToken } from '@/components/LaunchToken'
import { card } from '@/lib/meta'

export const metadata: Metadata = card({
  title: 'Launch a basket token',
  description:
    'Pick the stocks, name it, give it a picture. It raises on a curve, then buys the real shares into a vault every holder can redeem from.',
  path: '/tokens/new',
})

export default function Page() {
  return <LaunchToken />
}
