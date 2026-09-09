import { http, createConfig, injected } from 'wagmi'
import { activeChain } from './chain'

export const wagmiConfig = createConfig({
  chains: [activeChain],
  connectors: [injected()],
  transports: { [activeChain.id]: http() },
  ssr: true,
})
