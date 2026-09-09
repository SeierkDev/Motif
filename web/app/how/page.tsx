import { About } from '@/components/About'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'How it works',
  description:
    'Launch an index of tokenised equities in one transaction and earn a fee on every purchase. Buyers hold the real tokens in their own wallet, there is no vault and nothing to redeem, and any holder can sell the basket back in one transaction.',
  path: '/how',
})

export default function Page() {
  return <About />
}
