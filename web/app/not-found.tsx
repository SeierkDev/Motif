import Link from 'next/link'
import { card } from '@/lib/meta'

export const metadata = card({
  title: 'Not found',
  description: 'There is nothing at this address.',
  path: '/',
})

export default function NotFound() {
  return (
    <section className="view">
      <div className="wrap" style={{ maxWidth: 640 }}>
        <h2>Nothing here</h2>
        <div className="card dim" style={{ lineHeight: 1.7 }}>
          That motif does not exist, or the address is wrong. Motif ids start at zero and count up,
          so a link to one that was never published lands here.
          <div className="row" style={{ marginTop: 18, justifyContent: 'flex-start', gap: 10 }}>
            <Link className="btn" href="/explore">See what people launched</Link>
            <Link className="btn ghost" href="/">Home</Link>
          </div>
        </div>
      </div>
    </section>
  )
}
