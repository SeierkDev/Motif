import { Portfolio } from '@/components/Portfolio'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Portfolio',
  description: 'What you hold, what it is worth, and everything running against it.',
  path: '/portfolio',
})

export default function Page() {
  return <Portfolio />
}
