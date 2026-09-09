import { type PublicClient, parseAbi } from 'viem'
import { addresses } from './contracts'

const factoryAbi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
])

const V3_FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA' as const
const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Which pool a token and fee tier live in, asked once per tab.
 *
 * @dev Every quote on this page used to open with a `getPool`, and a pool's
 *      address is decided when it is created and never changes again. A five
 *      leg graduation estimate was ten reads where five would do, against the
 *      one public rpc this chain has, from every browser with the page open.
 *      Only a real answer is kept: a pair with no pool is asked again, because
 *      that one can change.
 */
const pools = new Map<string, `0x${string}`>()

async function poolFor(
  client: PublicClient,
  token: `0x${string}`,
  fee: number,
): Promise<`0x${string}` | null> {
  const key = `${token.toLowerCase()}:${fee}`
  const hit = pools.get(key)
  if (hit) return hit
  const pool = (await client.readContract({
    address: V3_FACTORY,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [addresses.usdg, token, fee],
  })) as `0x${string}`
  if (!pool || pool === ZERO) return null
  pools.set(key, pool)
  return pool
}

/**
 * USDG per whole token, 1e18, from a pool's `sqrtPriceX96`.
 *
 * @dev Exact. `PoolPrice.usdgPerToken` on chain carries the full 512 bit
 *      intermediate through FullMath, and this used to be a hand rolled port of
 *      the shift Solidity needs and JavaScript does not: sqrtP down 32, squared
 *      into a Q64, read back out of the low bits. On a stock at $232 the two
 *      agree to eleven figures, which is why nothing caught it. On a basket
 *      token at $0.00005 the shifted version is 0.08% low, and it falls apart
 *      from there. BigInt has no width to overflow, so there is nothing the
 *      shift buys.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, usdgIsZero: boolean): bigint {
  const squared = sqrtPriceX96 * sqrtPriceX96
  if (squared === 0n) return 0n
  return usdgIsZero ? ((10n ** 30n) << 192n) / squared : (squared * 10n ** 30n) >> 192n
}

/**
 * Estimate what a leg pays out, from the pool's own current price.
 *
 * This is deliberately a client side estimate rather than an on chain quote.
 * The contract never reads a price for settlement, only the per leg minimum
 * this produces, which is exactly the split the design asks for: the oracle and
 * the pool price inform the floor, and the floor is all the contract enforces.
 *
 * It ignores price impact, so it overestimates on a large order. That is safe
 * in the direction that matters only because the tolerance is applied on top;
 * a buyer moving real size should widen it.
 */
export async function quoteLeg(
  client: PublicClient,
  tokenOut: `0x${string}`,
  fee: number,
  amountIn: bigint,
): Promise<bigint> {
  const pool = await poolFor(client, tokenOut, fee)
  if (!pool) return 0n

  const [sqrtPriceX96] = await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'slot0',
  })

  // price = (sqrtPriceX96 / 2^96)^2, expressed as token1 per token0.
  const Q96 = 2n ** 96n
  const num = sqrtPriceX96 * sqrtPriceX96
  const usdgIsZero = addresses.usdg.toLowerCase() < tokenOut.toLowerCase()

  // Work in 1e18 fixed point so integer maths does not collapse to zero.
  const priceX18 = (num * 10n ** 18n) / (Q96 * Q96)

  let out: bigint
  if (usdgIsZero) {
    // token1 per token0: multiply.
    out = (amountIn * priceX18) / 10n ** 18n
  } else {
    // token0 per token1: divide.
    if (priceX18 === 0n) return 0n
    out = (amountIn * 10n ** 18n) / priceX18
  }

  // No decimal rescaling. The pool ratio is already expressed in raw units, so
  // multiplying by the decimal difference counts it a second time: a 10 NVDA
  // quote came out as 2.6e11 before this was removed.

  // The pool takes its fee off the input before swapping.
  return (out * BigInt(1_000_000 - fee)) / 1_000_000n
}

/**
 * Estimate what selling a leg pays back, in the quote asset.
 *
 * The mirror of `quoteLeg`, and deliberately the same ratio read the same way
 * round rather than a second derivation. The first version of the buy quote
 * rescaled a raw pool ratio by the decimal difference and reported a ten NVDA
 * order as 260 billion tokens, so this one takes the ratio exactly as the pool
 * expresses it and only chooses which way to divide.
 */
export async function quoteSell(
  client: PublicClient,
  token: `0x${string}`,
  fee: number,
  amountIn: bigint,
): Promise<bigint> {
  if (amountIn === 0n) return 0n
  const pool = await poolFor(client, token, fee)
  if (!pool) return 0n

  const [sqrtPriceX96] = await client.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'slot0',
  })

  const Q96 = 2n ** 96n
  const priceX18 = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96)
  if (priceX18 === 0n) return 0n
  const usdgIsZero = addresses.usdg.toLowerCase() < token.toLowerCase()

  // Selling the token is the opposite direction to buying it, so the branch
  // that multiplies there divides here.
  const out = usdgIsZero ? (amountIn * 10n ** 18n) / priceX18 : (amountIn * priceX18) / 10n ** 18n

  return (out * BigInt(1_000_000 - fee)) / 1_000_000n
}

/** Apply the buyer's tolerance to turn an estimate into an enforceable floor. */
export const floorFrom = (estimate: bigint, toleranceBps: number) =>
  (estimate * BigInt(10_000 - toleranceBps)) / 10_000n

/**
 * The pool's own spot price, USDG per whole token, 1e18.
 *
 * The same read the Orders contract does on chain, so what the form shows and
 * what the trigger compares against cannot disagree.
 */
export async function poolSpot(
  client: PublicClient,
  token: `0x${string}`,
  fee: number,
): Promise<bigint> {
  const pool = await poolFor(client, token, fee)
  if (!pool) return 0n
  const [sqrtPriceX96] = await client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' })
  return priceFromSqrt(sqrtPriceX96, addresses.usdg.toLowerCase() < token.toLowerCase())
}
