/**
 * A value that is set but empty is not a value, and `??` cannot tell.
 *
 * @dev **`ENV X=$UNSET_ARG` in a Dockerfile sets X to the empty string**, which
 *      is defined, so `process.env.X ?? fallback` hands back `''` and the
 *      fallback never fires. Every variable `web/Dockerfile` declares an `ARG`
 *      for is in exactly that state whenever the platform does not set it,
 *      which is the normal case for the optional ones. Adding an `ARG` for a
 *      variable therefore changes the behaviour of code that never mentioned
 *      it, which is how `NEXT_PUBLIC_META_TIMEOUT_MS` went from a 5s default to
 *      a 0ms one without a line of its own code changing.
 *
 *      Measured, not reasoned about: `process.env.EMPTY ?? 5000` is `''`,
 *      `Number('')` is 0, and a `fetch` given `AbortSignal.timeout(0)` fails
 *      every single time while the same call at 5000 returns 200.
 *
 *      Callers pass the literal `process.env.NEXT_PUBLIC_X` rather than a name,
 *      because Next inlines these at build time by matching that exact
 *      expression in the source. `process.env[name]` is not inlined and reads
 *      as undefined in the browser.
 *
 *      This file deliberately imports nothing, so the server side metadata
 *      path can use it without pulling the wagmi client graph in behind it.
 */
export function orElse(v: string | undefined, fallback: string): string {
  const t = (v ?? '').trim()
  return t === '' ? fallback : t
}

/**
 * The same rule for a number, plus the two ways a number can be wrong.
 *
 * `AbortSignal.timeout(NaN)` throws a RangeError rather than defaulting, and a
 * timeout of zero aborts before the request is made, so a typo in a dashboard
 * field must land on the default rather than on either of those.
 */
export function numOrElse(v: string | undefined, fallback: number): number {
  const n = Number((v ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * An origin, with the scheme the platform did not give you.
 *
 * @dev **A string with no scheme is a relative path, not a url**, and that is
 *      how it fails: `fetch('api.example.com/v1/x')` from a page on
 *      `site.example.com` requests `site.example.com/api.example.com/v1/x` and
 *      gets a 404. Nothing throws, so it reads as the api being down.
 *
 *      Observed in a browser against the real deployment, not imagined:
 *
 *        GET https://sincere-essence-production-40a8.up.railway.app
 *            /motif-private-production.up.railway.app/v1/leaderboard  404
 *
 *      The value that does this is the one the platform hands you.
 *      `${RAILWAY_PUBLIC_DOMAIN}` expands to a bare host, so the wrong value is
 *      the natural thing to paste, and it had already broken the build once
 *      through `NEXT_PUBLIC_SITE_URL` before it broke every api call through
 *      `NEXT_PUBLIC_API`. Two variables, one platform, the same paste. So this
 *      lives in one place and both use it.
 *
 *      A missing scheme is unambiguous and is added rather than reported: there
 *      is no other scheme a public host would have meant. `http://` is left
 *      alone because a local api genuinely is one. Trailing slashes go, because
 *      every caller appends a path that starts with one.
 */
export function origin(v: string | undefined, fallback: string): string {
  const raw = orElse(v, '').replace(/\/+$/, '')
  if (raw === '') return fallback
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    // Parsed rather than trusted, so a value wrong in some other way lands on
    // the fallback instead of being handed to fetch or to `new URL()`.
    const u = new URL(withScheme)
    if (u.hostname === '') return fallback
    return withScheme
  } catch {
    console.warn(`[env] not a url, falling back: ${JSON.stringify(withScheme)}`)
    return fallback
  }
}
