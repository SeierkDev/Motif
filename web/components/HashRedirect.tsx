'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Old hash links keep working.
 *
 * Every url this site had until now was a fragment, and a fragment is never
 * sent to a server, so the routes below cannot see it. Anything already posted
 * or bookmarked would land on the home page with no explanation. This reads the
 * fragment once on load and replaces it with the real path.
 *
 * `replace` rather than `push`, so the back button does not bounce between the
 * old url and the new one forever.
 */
const MAP: Record<string, (arg?: string) => string | null> = {
  home: () => '/',
  explore: () => '/explore',
  create: () => '/launch',
  launch: () => '/launch',
  orders: () => '/orders',
  portfolio: () => '/portfolio',
  how: () => '/how',
  motif: (arg) => (arg && /^\d+$/.test(arg) ? `/m/${arg}` : null),
  creator: (arg) => (arg && /^0x[0-9a-fA-F]{40}$/.test(arg) ? `/c/${arg}` : null),
}

export function HashRedirect() {
  const router = useRouter()

  useEffect(() => {
    const hash = window.location.hash.replace(/^#\/?/, '')
    if (!hash) return
    const [head, arg] = hash.split('/')
    const to = MAP[head ?? '']?.(arg)
    if (to) router.replace(to)
  }, [router])

  return null
}
