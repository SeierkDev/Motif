import { Explore } from '@/components/Explore'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Explore motifs',
  description:
    'Every index anyone has published on Robinhood Chain, ranked by what actually happened: money through the basket, fees earned by its creator, and return since launch.',
  path: '/explore',
})

/** The same grid as the home page, kept at its own url because it was linked
 *  and shared as one before the front door became the grid. */
export default function Page() {
  return <Explore />
}
