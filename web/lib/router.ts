'use client'

import { useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { addresses, basketRouterAbi } from '@/lib/contracts'

/**
 * Whether the router that is actually deployed can record a picture.
 *
 * `createIndex` and `createAndBuy` are both overloaded, and viem picks between
 * the shapes on arity, so the site decides which selector it sends. A router
 * published before pictures existed does not implement the longer one and has
 * no fallback, so that call reverts with nothing attached: the launch fails
 * after the USDG approval has already been signed, and the revert says nothing
 * about pictures. Asking first is a single read against an answer that cannot
 * change.
 *
 * The probe is `MAX_IMAGE_BYTES()`, a constant that exists only on the router
 * that understands one. That is a question about meaning rather than a grep of
 * the bytecode for a selector: same answer, and this one cannot be a
 * coincidence.
 *
 * `null` is unknown rather than no. An unreachable rpc looks exactly like a
 * router without the function from here, and treating that as no would drop
 * somebody's picture silently, which is the failure this whole module exists to
 * avoid.
 */
export type RouterImages = boolean | null

const answered = new Map<string, boolean>()

export async function routerTakesImage(
  client: { readContract: (a: never) => Promise<unknown>; chain?: { id: number } } | undefined,
): Promise<RouterImages> {
  if (!client) return null
  const key = `${client.chain?.id ?? 0}:${addresses.basketRouter}`
  const known = answered.get(key)
  if (known !== undefined) return known
  try {
    await client.readContract({
      address: addresses.basketRouter,
      abi: basketRouterAbi,
      functionName: 'MAX_IMAGE_BYTES',
    } as never)
    // Only a real answer is cached. A failure is not, because it may have been
    // the network rather than the contract, and caching that would outlive the
    // outage that caused it.
    answered.set(key, true)
    return true
  } catch (e: unknown) {
    // The chain answering "no such function" and the rpc not answering at all
    // are different answers, and viem does not make that easy: it wraps both in
    // a `ContractFunctionExecutionError`, so testing the outer error's name
    // reads a refused request as a router without the function. Measured
    // against a stub that returned an rpc error rather than a revert: the
    // launch form disabled its picture control and said the router could not
    // record one, which was a claim about the contract made on the strength of
    // a network failure.
    //
    // So the cause chain is walked instead, and only the shapes the chain
    // itself produces count. Everything else is unknown, and unknown stays
    // null.
    //
    // The three are not interchangeable and the list was one short when it was
    // written. Measured against a node that refuses the call the way this chain
    // does, the chain reads
    // `ContractFunctionExecutionError -> CallExecutionError ->
    //  ExecutionRevertedError -> InvalidInputRpcError -> RpcRequestError`,
    // so `ExecutionRevertedError` is the one that actually appears: a revert
    // with no data comes back as an rpc error rather than as
    // `ContractFunctionRevertedError`, which is the shape for a revert that
    // carries a reason. `ContractFunctionZeroDataError` is the third, for a
    // node that answers `0x` instead of refusing.
    const decisive = new Set([
      'ExecutionRevertedError',
      'ContractFunctionRevertedError',
      'ContractFunctionZeroDataError',
    ])
    let cur: unknown = e
    for (let hops = 0; cur instanceof Error && hops < 8; hops++) {
      if (decisive.has(cur.name)) {
        answered.set(key, false)
        return false
      }
      cur = (cur as { cause?: unknown }).cause
    }
    return null
  }
}

/** The same question, answered once when a launch form mounts. */
export function useRouterImages(): RouterImages {
  const client = usePublicClient()
  const [state, setState] = useState<RouterImages>(null)
  useEffect(() => {
    let live = true
    routerTakesImage(client as never).then((r) => {
      if (live) setState(r)
    })
    return () => {
      live = false
    }
  }, [client])
  return state
}

/**
 * The router's own per transaction cap, in usdg's six decimals.
 *
 * `Guarded` bounds what one call may spend, and zero means no cap. The launch
 * form asks so it can say the number rather than letting somebody type an
 * amount that reverts at the wallet with `OverCap` and no explanation of what
 * the ceiling actually is.
 *
 * `null` is unknown here too, for the same reason as above: a read that did not
 * come back is not a cap of zero, and rendering it as "no limit" would be
 * inventing permission the chain never gave.
 */
export function useMaxNotional(): bigint | null {
  const client = usePublicClient()
  const [cap, setCap] = useState<bigint | null>(null)
  useEffect(() => {
    let live = true
    if (!client) return
    client
      .readContract({
        address: addresses.basketRouter,
        abi: basketRouterAbi,
        functionName: 'maxNotional',
      })
      .then((v) => {
        if (live) setCap(v as bigint)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client])
  return cap
}
