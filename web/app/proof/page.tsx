import { Proof } from '@/components/Proof'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Proof',
  description:
    'Every Motif contract address, linked to the explorer, with what each one holds read live from chain. How fresh the data is, the fee split, the keeper and the burn, all read rather than written down.',
  path: '/proof',
})

export default function Page() {
  return <Proof />
}
