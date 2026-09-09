/**
 * A health route for the site, so that /healthz is the right answer for both
 * services rather than each needing a different one.
 *
 * The api serves /healthz and 404s on /. Next serves / and, until this existed,
 * 404d on /healthz. So a platform healthcheck had to be set to the opposite
 * path per service, and getting it the wrong way round costs five minutes of
 * retries and a failed deploy that says only "404 on all 14 attempts". Both
 * mistakes were made here, one per service, on the same afternoon.
 *
 * force-dynamic because a statically rendered health route would answer from
 * the build rather than from the running server, which is the one thing a
 * health check must never do.
 */
/* `origin` from env.ts rather than `API` from api.ts: that module is
   'use client', so importing it into a server route hands back a client
   reference and the field came out undefined, which JSON then dropped
   entirely. A diagnostic that silently omits the field you are diagnosing is
   worse than none. */
import { addresses, factoryAddress, sourceUrl, swapAddress } from '@/lib/contracts'
import { origin } from '@/lib/env'

export const dynamic = 'force-dynamic'

/**
 * It also reports what the build actually baked in.
 *
 * @dev `NEXT_PUBLIC_*` is inlined at build time, so whether a variable reached
 *      the image is invisible from outside: a missing source link, a site
 *      calling itself for the api, and a variable nobody ever set all look the
 *      same on the page. Three separate rounds were spent on "the GitHub icon
 *      is not there" with no way to tell whether the value was absent, present
 *      but rejected, or present in a build that had not deployed yet.
 *
 *      Only whether each is set and how it resolved. No secrets: every one of
 *      these is already in the browser bundle by definition, which is what
 *      NEXT_PUBLIC_ means.
 */
export function GET() {
  const show = (v: string | undefined) => (v === undefined ? null : v === '' ? '(empty)' : v)
  return Response.json({
    ok: true,
    // Resolved, so the answer includes any normalising the site does.
    resolved: {
      api: origin(process.env.NEXT_PUBLIC_API, 'http://127.0.0.1:8787'),
      sourceUrl,
      factory: factoryAddress,
      swap: swapAddress,
      router: addresses.basketRouter,
    },
    // Raw, so a value that was set but rejected is distinguishable from unset.
    raw: {
      NEXT_PUBLIC_API: show(process.env.NEXT_PUBLIC_API),
      NEXT_PUBLIC_SITE_URL: show(process.env.NEXT_PUBLIC_SITE_URL),
      NEXT_PUBLIC_SOURCE_URL: show(process.env.NEXT_PUBLIC_SOURCE_URL),
      NEXT_PUBLIC_ROUTER: show(process.env.NEXT_PUBLIC_ROUTER),
      NEXT_PUBLIC_REBALANCER: show(process.env.NEXT_PUBLIC_REBALANCER),
      NEXT_PUBLIC_ORDERS: show(process.env.NEXT_PUBLIC_ORDERS),
      NEXT_PUBLIC_FACTORY: show(process.env.NEXT_PUBLIC_FACTORY),
      NEXT_PUBLIC_SWAP: show(process.env.NEXT_PUBLIC_SWAP),
      NEXT_PUBLIC_META_TIMEOUT_MS: show(process.env.NEXT_PUBLIC_META_TIMEOUT_MS),
    },
  })
}
