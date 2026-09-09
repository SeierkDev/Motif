'use client'

import { useEffect, useState } from 'react'
import { erc20Abi } from 'viem'
import { useAccount, usePublicClient } from 'wagmi'
import { addresses } from '@/lib/contracts'

/**
 * What the connected wallet actually holds, in usdg's six decimals.
 *
 * The launch forms ask so an amount somebody types can be checked against
 * something real before it is signed. Typing more than you have is the ordinary
 * way a launch fails, and it fails at the wallet with a transfer revert that
 * says nothing about which of the three ceilings was hit.
 *
 * `null` is unknown, not zero, the same distinction the rest of this codebase
 * makes: no wallet, an rpc that did not answer, and a genuinely empty wallet are
 * three different sentences and only the third is worth refusing over.
 */
export function useUsdgBalance(): bigint | null {
  const { address } = useAccount()
  const client = usePublicClient()
  const [bal, setBal] = useState<bigint | null>(null)

  useEffect(() => {
    let live = true
    if (!client || !address) {
      setBal(null)
      return
    }
    client
      .readContract({
        address: addresses.usdg,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address],
      })
      .then((v) => {
        if (live) setBal(v as bigint)
      })
      .catch(() => {
        if (live) setBal(null)
      })
    return () => {
      live = false
    }
  }, [client, address])

  return bal
}
