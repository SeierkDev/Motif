/**
 * The keeper against an rpc that refuses, measured rather than asserted.
 *
 * This exists because "the keeper needs a paid rpc" was written down as a fact
 * and there is no paid rpc for this chain to buy. What was actually true is
 * that the keeper handled a refusal badly in two places: a refused read was
 * swallowed, so it looked healthy while doing nothing, and a refused send
 * counted toward the consecutive failure limit, so five busy minutes stopped it
 * permanently and it needed a hand to come back.
 *
 * Both are behaviour rather than shape, so both are run here against a reader
 * that refuses, in the same style as check-addresses: a script that exits
 * non-zero, wired into CI, needing no chain.
 */
import { unlinkSync } from 'node:fs'
import { open } from './db.js'
import { isRefusal, Pace } from './rpc.js'
import { Keeper } from './keeper.js'

let bad = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
    bad++
  }
}

// ---------------------------------------------------------------- isRefusal

/** The shape viem actually hands back: the status is on a nested cause. */
const viem429 = Object.assign(new Error('HTTP request failed.'), {
  cause: Object.assign(new Error('Too Many Requests'), { status: 429 }),
})
const viemRevert = Object.assign(new Error('execution reverted: NotReady'), {
  cause: Object.assign(new Error('reverted'), { data: '0x' }),
})

console.log('isRefusal')
check('a nested 429 is a refusal', isRefusal(viem429))
check('a plain 503 is a refusal', isRefusal({ status: 503 }))
check('a revert is not a refusal', !isRefusal(viemRevert))
check('a gas error is not a refusal', !isRefusal(new Error('insufficient funds for gas')))
check('nothing is not a refusal', !isRefusal(null) && !isRefusal(undefined))

// --------------------------------------------------------------------- Pace

console.log('Pace')
{
  const pace = new Pace(40)
  const started = Date.now()
  for (let i = 0; i < 5; i++) await pace.next()
  const took = Date.now() - started
  // Four gaps between five calls, so 160ms is the floor. Generous upper bound:
  // this is asserting that it spreads, not that timers are precise.
  check(`five calls at a 40ms gap took ${took}ms`, took >= 150 && took < 2_000)
}

// ------------------------------------------------------------------- Keeper

const PATH = '/tmp/motif-check-keeper.sqlite'
try {
  unlinkSync(PATH)
} catch {
  /* first run */
}
const db = open(PATH)
const INSERT_ORDER =
  'INSERT INTO orders (id, owner, token, kind, amount, active, block) VALUES (?,?,?,?,?,1,0)'
db.run(INSERT_ORDER, [
  1,
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
  0,
  '1',
])

// anvil's first dev account. Public, worthless, and the same on every machine.
process.env.MOTIF_KEEPER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
// The sweeps below run through the process-wide pacer at its real 250ms gap.
// It is not overridden here: an import is evaluated before any statement in
// this file, so setting the variable at this point would be setting it after
// the pacer had already read it, and a check that quietly does not do what its
// own line says is worse than one that takes four seconds.

console.log('Keeper, against an rpc that refuses every read')
{
  const keeper = new Keeper(db as never)
  // The reader is replaced rather than pointed at a dead url, because a dead
  // url gives a connection error and the thing under test is a live endpoint
  // saying no.
  ;(keeper as unknown as { reader: unknown }).reader = {
    readContract: async () => {
      throw viem429
    },
  }

  await keeper.sweep()
  const first = keeper.status()
  const t = (s: ReturnType<Keeper['status']>) => JSON.stringify(s.throttle)
  check('one refused sweep backs off', first.throttle.sweepEverySeconds === 40, t(first))
  check('and reports itself throttled rather than running', first.state === 'throttled')
  check('and is not stopped', keeper.stopped === null)

  for (let i = 0; i < 6; i++) await keeper.sweep()
  const later = keeper.status()
  check('six more refusals do not stop it', keeper.stopped === null)
  check('and the backoff is capped', later.throttle.sweepEverySeconds === 300, t(later))
  check('and every refusal is counted', later.throttle.refusals === 7, `${later.throttle.refusals}`)

  // The endpoint comes back.
  ;(keeper as unknown as { reader: unknown }).reader = {
    readContract: async () => [false, 'not ready', 0n],
  }
  await keeper.sweep()
  const back = keeper.status()
  check('one read getting through resets the interval', back.throttle.sweepEverySeconds === 20)
  check('and it reports running again', back.state === 'running')
}

console.log('Keeper, against a chain that keeps rejecting the call')
{
  const keeper = new Keeper(db as never)
  ;(keeper as unknown as { reader: unknown }).reader = {
    readContract: async () => [true, 'ready', 0n],
  }
  ;(keeper as unknown as { wallet: unknown }).wallet = {
    account: { address: '0x0000000000000000000000000000000000000003' },
    writeContract: async () => {
      throw new Error('insufficient funds for gas * price + value')
    },
  }

  for (let i = 0; i < 5; i++) await keeper.sweep()
  check('five real failures still stop it', keeper.stopped !== null, `${keeper.stopped}`)
  check('and it is not called throttling', keeper.status().throttle.refusals === 0)
}

db.close()
console.log(
  bad
    ? `${bad} failed`
    : 'the keeper survives a refusing rpc, and still stops on a real failure',
)
process.exit(bad ? 1 : 0)
