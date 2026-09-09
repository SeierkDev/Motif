import { createPublicClient, http, parseAbi, type Address, type PublicClient } from 'viem'
import { config } from './indexer.js'

const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
])

/** Discovered on chain in Phase 0. Not the canonical mainnet factory. */
export const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as const
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Which pool a token and fee tier live in, asked once.
 *
 * @dev A V3 factory's `getPool` is deterministic and its answer is permanent:
 *      a pool is created once and never moves. Asking again every sweep is a
 *      request that cannot return anything new, and this chain has one public
 *      rpc that refuses under load, so the useful thing to do with a request
 *      whose answer cannot change is not to make it. Twelve tickers on a
 *      minute timer is twelve calls an hour rather than seven hundred.
 *
 *      Only a real answer is cached. A pair with no pool yet is asked again,
 *      because that one *can* change.
 */
const pools = new Map<string, Address>()

export async function poolFor(
  client: PublicClient,
  token: Address,
  fee: number,
): Promise<Address | null> {
  const key = `${token.toLowerCase()}:${fee}`
  const hit = pools.get(key)
  if (hit) return hit

  const pool = (await client.readContract({
    address: V3_FACTORY,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [USDG, token, fee],
  })) as Address
  if (!pool || pool === ZERO) return null
  pools.set(key, pool)
  return pool
}

/**
 * USDG per whole token, 1e18, read from the pool.
 *
 * The pool rather than Chainlink, for the same reason the order contract uses
 * it: the stock feeds run 24/5 and update on deviation, so a level computed
 * from them would freeze every weekend and lie about the gaps. The pool is
 * where the token actually trades and it never closes. It is also the only
 * source that covers every leg, since a leg is required to have a pool but is
 * not required to have a registered feed.
 */
export async function poolPrice(
  client: PublicClient,
  token: Address,
  fee: number,
  known?: Address | null,
): Promise<bigint | null> {
  const pool = known && known !== ZERO ? known : await poolFor(client, token, fee)
  if (!pool || pool === ZERO) return null

  const slot0 = (await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'slot0',
  })) as readonly [bigint, number, number, number, number, number, boolean]

  const sqrtP = slot0[0]
  if (sqrtP === 0n) return null
  // A locked pool is mid swap, so slot0 is not a price to record.
  if (!slot0[6]) return null

  return priceFromSqrt(sqrtP, USDG.toLowerCase() < token.toLowerCase())
}

/**
 * USDG per whole token, 1e18, from a pool's `sqrtPriceX96`.
 *
 * `ratio = token1 per token0 = sqrtP^2 / 2^192`, in raw units. Which way up
 * that is depends only on how the two addresses happened to sort, so both are
 * written out rather than one being derived from the other. The 1e30 carries
 * the 1e18 the answer is quoted in and the twelve decimal places between an 18
 * decimal stock token and 6 decimal USDG.
 *
 * @dev **Exact, and it did not used to be.** This was a port of the shifting
 *      Solidity has to do to keep `sqrtP^2` inside 256 bits: shift sqrtP down
 *      32, square it into a Q64 fixed point, then read the answer back out of
 *      that. JavaScript's BigInt has no width to overflow, so all the shift
 *      bought was lost precision, and how much was lost depended on the size of
 *      the number. Stock pools price around 1e20 and were fine. A basket token
 *      opens near 5e13 and falls from there, and when it is the token1 side the
 *      whole answer comes out of the low bits: measured against this, the old
 *      arithmetic was 0.08% low at a basket's opening price, 2.4% low a
 *      fiftieth of the way down, 46% low at a five hundredth, and returned a
 *      flat zero below about $0.00000005, which `Levels` drops as unreadable.
 *      So a basket token's chart would quantise, then bend, then stop, and
 *      which tokens it happened to was decided by nothing but whether the vault
 *      address sorted above or below USDG.
 *
 *      `check-prices.ts` measures both sides against exact rational arithmetic.
 */
export function priceFromSqrt(sqrtP: bigint, usdgIsZero: boolean): bigint | null {
  const squared = sqrtP * sqrtP
  if (squared === 0n) return null
  const price = usdgIsZero
    ? ((10n ** 30n) << 192n) / squared
    : (squared * 10n ** 30n) >> 192n
  return price > 0n ? price : null
}

export function reader(): PublicClient {
  return createPublicClient({ transport: http(config.RPC) }) as PublicClient
}
