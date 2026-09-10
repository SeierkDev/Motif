import { defineChain } from 'viem'

/**
 * Robinhood Chain. An Arbitrum Orbit L2, mainnet 4663 and testnet 46630.
 *
 * The rpc is POST only: opening it in a browser returns a JSON parse error
 * that looks like an outage and is not one.
 */
export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
  // Deployed here at its usual address, checked on chain. Declaring it is what
  // lets a page ask for many reads in one request: /proof reads seventy eight
  // balances on every refresh, and the public rpc refuses bursts.
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

/**
 * A local anvil fork of mainnet, which is how this is developed. It carries the
 * real Uniswap V3 pools and the real stock tokens, so nothing has to be mocked
 * and no faucet is needed.
 */
export const localFork = defineChain({
  ...robinhood,
  id: 4663,
  name: 'Robinhood Chain (local fork)',
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
})

export const activeChain = process.env.NEXT_PUBLIC_LOCAL === '1' ? localFork : robinhood
