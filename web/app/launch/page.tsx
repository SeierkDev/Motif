import { Create } from '@/components/Create'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Launch a motif',
  description:
    'Pick real stocks, set the weights, name it and publish. It takes one transaction, it can never be edited, and you earn a fee on every purchase for as long as it exists.',
  path: '/launch',
})

export default function Page() {
  return <Create />
}
