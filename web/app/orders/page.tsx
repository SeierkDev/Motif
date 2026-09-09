import { OrdersView } from '@/components/Orders'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Orders',
  description:
    'Limit orders, stop losses, trailing stops and TWAP on tokenised equities. They read the pool rather than an oracle, so they fire at a weekend when the exchange is shut.',
  path: '/orders',
})

export default function Page() {
  return <OrdersView />
}
