import abi from './abi.json'
import { orElse, origin } from './env'

/** Where the source link points when nothing overrides it. */
const DEFAULT_SOURCE_URL = 'https://github.com/SeierkDev/Motif'

export const basketRouterAbi = abi.BasketRouter
export const rebalancerAbi = abi.Rebalancer
export const ordersAbi = abi.Orders
export const basketCurveAbi = abi.BasketCurve
export const basketVaultAbi = abi.BasketVault
export const basketFactoryAbi = abi.BasketFactory
export const tokenSwapAbi = abi.TokenSwap

/** Deployed by script/Deploy.s.sol. Local fork values until testnet is funded. */
export const addresses = {
  basketRouter: orElse(
    process.env.NEXT_PUBLIC_ROUTER,
    '0x512F7469BcC83089497506b5df64c6E246B39925',
  ) as `0x${string}`,
  rebalancer: orElse(
    process.env.NEXT_PUBLIC_REBALANCER,
    '0x9fD16eA9E31233279975D99D5e8Fc91dd214c7Da',
  ) as `0x${string}`,
  orders: orElse(
    process.env.NEXT_PUBLIC_ORDERS,
    '0x987e855776C03A4682639eEb14e65b3089EE6310',
  ) as `0x${string}`,
  usdg: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as `0x${string}`,
}

/**
 * Where basket tokens are launched from, and it is deliberately allowed to be
 * missing.
 *
 * Nothing tokenised is deployed yet, and a site that refused to build without a
 * factory address could not be built against the router that is actually live.
 * Empty means the launch form says so instead of offering a button that reverts.
 * The api makes the same distinction on `/v1/status` under `chain.factory`.
 */
export const factoryAddress = (() => {
  const v = (process.env.NEXT_PUBLIC_FACTORY ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null
})()

/**
 * The contract that lets a wallet trade a basket token's own pool, and it is
 * allowed to be missing for the same reason the factory is.
 *
 * A Uniswap V3 pool calls back into its caller to collect the input, and a
 * wallet has no code to answer with, so trading one needs a contract in front.
 * Without this address the token page still works: it prices the token, draws
 * the chart, and offers redemption, which pays the backing and is the exit that
 * never depends on anybody. What it does not do is pretend there is a market
 * button when there is nothing deployed behind it.
 */
export const swapAddress = (() => {
  const v = (process.env.NEXT_PUBLIC_SWAP ?? '').trim()
  return /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null
})()

export const isAddress = (s: string): s is `0x${string}` => /^0x[0-9a-fA-F]{40}$/.test(s)

/**
 * The twelve tickers with a real USDG pool, found by walking the V3 factory
 * rather than taken from any list. Everything else on the chain is a memecoin.
 */
export const TOKENS: Record<string, { symbol: string; name: string; fee: number }> = {
  '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC': { symbol: 'NVDA', name: 'NVIDIA', fee: 500 },
  '0x322F0929c4625eD5bAd873c95208D54E1c003b2d': { symbol: 'TSLA', name: 'Tesla', fee: 3000 },
  '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B': { symbol: 'AMC', name: 'AMC Entertainment', fee: 3000 },
  '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f': { symbol: 'SLV', name: 'iShares Silver', fee: 3000 },
  '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5': { symbol: 'SGOV', name: 'iShares 0-3M Treasury', fee: 3000 },
  '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C': { symbol: 'SPY', name: 'S&P 500 ETF', fee: 500 },
  '0xec262a75e413fAfD0dF80480274532C79D42da09': { symbol: 'MSTR', name: 'MicroStrategy', fee: 10000 },
  '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8': { symbol: 'NFLX', name: 'Netflix', fee: 3000 },
  '0x4e62068525Ab11FE768e29dfD00ef909B9803016': { symbol: 'LULU', name: 'Lululemon', fee: 3000 },
  '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4': { symbol: 'BABA', name: 'Alibaba', fee: 3000 },
  '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516': { symbol: 'DJT', name: 'Trump Media', fee: 10000 },
  '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa': { symbol: 'SPCX', name: 'SpaceX', fee: 500 },
}

export const tokenList = Object.entries(TOKENS).map(([address, t]) => ({
  address: address as `0x${string}`,
  ...t,
}))

/**
 * A colour per ticker, fixed for the life of the app.
 *
 * Assigned by ticker rather than by position in a basket, which is what the
 * first version did: leg zero was always lime, so every tile in the grid was a
 * wall of the same green and the colours told you nothing. Keyed this way, NVDA
 * is the same colour in a tile, a chart and a weight slider, and the palette
 * becomes something a regular can read at a glance.
 */
const PALETTE = [
  '#ccff33', '#ff8a3d', '#57d9ff', '#c48cff', '#ff6fb5', '#35e0b0',
  '#ffd23d', '#6aa8ff', '#ff5f56', '#a9f06a', '#b3a5ff', '#8b93a3',
]

export const colorOf = (addr: string) => {
  const i = tokenList.findIndex((t) => t.address.toLowerCase() === addr.toLowerCase())
  return PALETTE[(i === -1 ? tokenList.length : i) % PALETTE.length]!
}

export const symbolOf = (addr: string) =>
  TOKENS[Object.keys(TOKENS).find((k) => k.toLowerCase() === addr.toLowerCase()) ?? '']?.symbol ??
  `${addr.slice(0, 6)}...`

/**
 * Where the source lives, and it is allowed to be missing.
 *
 * @dev Now `github.com/SeierkDev/Motif`, which is public and is the code this
 *      site is built from. It pointed at `motif-private` for as long as that
 *      was the only place the code existed, and before that at a repository
 *      that had never existed at all, so every page carried a 404 on the one
 *      control whose entire purpose is "check this yourself".
 *
 *      The two are kept byte identical by `scripts/publish.sh`, so what a
 *      reader finds there is what is running here.
 *
 *      `none`, `off` or `false` in `NEXT_PUBLIC_SOURCE_URL` still hides the
 *      link rather than rendering a broken one.
 */
/**
 * The project's account on X, in one place.
 *
 * @dev It was `https://x.com/SeierkDev` written out twice, in `Header.tsx` and
 *      in `Footer.tsx`. Two things wrong with that. It is the author's personal
 *      account rather than the project's, and this project is not supposed to
 *      look connected to any other of them; and a value hard coded in two files
 *      gets changed in one, which is the shape of half the bugs in CLAUDE.md.
 *
 *      A constant rather than a `NEXT_PUBLIC_` variable on purpose. The handle
 *      is not deployment configuration: it does not differ between a local run
 *      and production, and every one of those variables has to be declared in
 *      `web/Dockerfile` twice and kept in `scripts/check-env.mjs`. That cost is
 *      worth paying for a value the platform supplies and not for one the
 *      repository knows.
 */
export const X_HANDLE = 'MotifFund'
export const xUrl = `https://x.com/${X_HANDLE}` as const

/**
 * The MOTIF token, and where it trades.
 *
 * @dev Constants rather than `NEXT_PUBLIC_` variables, for the same reason the
 *      X handle is: this does not differ between a local run and production,
 *      and every one of those variables costs two declarations in
 *      `web/Dockerfile` and an entry in `scripts/check-env.mjs`.
 *
 *      **This token is not part of the protocol.** Nothing in `src/` reads it,
 *      no fee is routed to it and holding it grants nothing. It is a separate
 *      thing that happens to share the name, and the footer says so rather than
 *      letting a link next to "Contracts and app" imply otherwise.
 */
export const TOKEN_ADDRESS = '0x89565a7BBfddab021844e2f66a79852e46C802df' as const
export const tokenUrl = `https://www.ponsfamily.com/launchpad/${TOKEN_ADDRESS}` as const

export const sourceUrl = (() => {
  /*
   * Defaults to the repository rather than to nothing.
   *
   * @dev This was env only, and hiding the link when unset was the right call
   *      once: the url was hard coded to `github.com/SeierkDev/motif`, a repo
   *      that does not exist, so every page carried a 404 on the one control
   *      whose whole purpose is "check it yourself".
   *
   *      That reasoning does not survive knowing the real url. A link to a
   *      private repo is a 404 today and correct the day it goes public; a link
   *      to a repo that never existed is wrong forever. Those are not the same
   *      thing, and treating them the same cost four rounds of "the icon is
   *      still not there" against a variable that never reached the build.
   *
   *      So the default is the real repository and the variable is now an
   *      override rather than a switch. `none`, `off` or `false` hides the
   *      link, which was the escape hatch for shipping while the repo was
   *      still private. It is public now, so the default resolves.
   */
  const raw = orElse(process.env.NEXT_PUBLIC_SOURCE_URL, DEFAULT_SOURCE_URL)
  if (/^(none|off|false)$/i.test(raw)) return null
  const v = origin(raw, DEFAULT_SOURCE_URL)
  return /^https:\/\/\S+$/.test(v) ? (v as `https://${string}`) : null
})()
