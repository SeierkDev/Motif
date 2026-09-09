import { Explore } from '@/components/Explore'

/**
 * The home page is the grid.
 *
 * A launchpad's front door is its inventory, not a pitch: somebody arriving
 * wants to see what people have launched, and the argument for the product is
 * only interesting once they have. The explanation lives at /how, linked from
 * the header, rather than standing between a visitor and the thing itself.
 */
export default function Page() {
  return <Explore />
}
