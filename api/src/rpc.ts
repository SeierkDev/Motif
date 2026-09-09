/**
 * What talking to one public rpc costs, and how not to get refused by it.
 *
 * This chain has a single public endpoint and there is no paid one to buy, so
 * "use a better rpc" is not an answer available to this service. Everything
 * here exists to make the keeper survive that endpoint rather than to pretend
 * it is a better one.
 *
 * Two separate problems, and they need different answers:
 *
 * - **A burst gets refused where the same requests spread out do not.** A sweep
 *   of fifty open orders fired fifty reads as fast as the event loop would
 *   allow. `Pace` puts a floor under the gap between them, so the same work
 *   arrives as a trickle. Nothing is dropped and nothing is skipped, it just
 *   uses the sweep window it already had.
 * - **A refusal is not a failure of the thing being attempted.** A 429 says
 *   nothing about whether an order is fillable, so counting one toward the
 *   keeper's consecutive failure limit stops a healthy keeper permanently and
 *   needs a human to start it again. `isRefusal` separates the two.
 */

/**
 * Whether an error is the endpoint refusing service rather than the chain
 * answering. Matched on the shapes viem actually produces: it wraps the http
 * status in an error carrying `status`, and nests transport errors under
 * `cause`, sometimes more than once.
 *
 * Kept deliberately narrow, and the string matches are a fallback rather than
 * the first test, because the expensive mistake is the other way round: a
 * keeper that reads every revert as a rate limit never stops and never says
 * why. Anything not recognised here stays a real failure.
 */
export function isRefusal(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false

  const status = (e as { status?: unknown }).status
  if (status === 429 || status === 502 || status === 503 || status === 504) return true

  const cause = (e as { cause?: unknown }).cause
  if (cause !== undefined && cause !== null && cause !== e && isRefusal(cause)) return true

  const message = (e as { message?: unknown }).message
  if (typeof message !== 'string') return false
  const m = message.toLowerCase()
  return (
    m.includes('429') ||
    m.includes('too many requests') ||
    m.includes('rate limit') ||
    m.includes('service unavailable')
  )
}

/**
 * A gate that lets one caller through every `gapMs`, in the order they asked.
 *
 * Serialised on a promise chain rather than a token bucket, because the thing
 * wanted is the gap between consecutive requests and a bucket only bounds the
 * average: a full bucket releases its whole burst at once, which is exactly
 * what this exists to prevent.
 */
export class Pace {
  private tail: Promise<void> = Promise.resolve()
  private last = 0

  constructor(private gapMs: number) {}

  next(): Promise<void> {
    const mine = this.tail.then(async () => {
      const wait = this.gapMs - (Date.now() - this.last)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.last = Date.now()
    })
    // A rejection must never poison the chain: the queue has to keep draining.
    this.tail = mine.catch(() => {})
    return mine
  }
}

/**
 * The gate every chain read in this process goes through.
 *
 * @dev One gate rather than one per component, because there is one endpoint.
 *      The indexer, the level sweep and the keeper all talk to the same public
 *      rpc, so three independent pacers would each be polite on their own and
 *      arrive together, which is the burst none of them meant to send.
 *
 *      250ms by default. That is not a rate chosen to fix a 429, which is the
 *      lever this repo already records four commits of pulling; it is there so
 *      that work which happens to fall on the same tick leaves in a line
 *      instead of all at once.
 */
export const chainPace = new Pace(Number(process.env.MOTIF_RPC_GAP_MS ?? 250))
