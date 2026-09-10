'use client'

import type { ReactNode } from 'react'
import { erc20Abi } from 'viem'
import { useBlockNumber, useReadContracts } from 'wagmi'
import { activeChain } from '@/lib/chain'
import { short, useApi, usdgPrecise } from '@/lib/api'
import {
  addresses,
  basketRouterAbi,
  BURNER_ADDRESS,
  factoryAddress,
  FEE_WALLET,
  swapAddress,
  TOKEN_ADDRESS,
  tokenList,
} from '@/lib/contracts'

const EXPLORER = activeChain.blockExplorers?.default.url ?? 'https://robinhoodchain.blockscout.com'
/** Every read on the page, from the chain and from the api alike. */
const REFRESH = 30_000
/** Still being read. Shown instead of a zero, because unknown is not none. */
const READING = '…'

/** The parts of `/v1/status` this page reads. */
type Status = {
  ok: boolean
  indexer: { lastBlock: number; secondsSinceRun: number | null; error: string | null }
  keeper: {
    state: string
    address: string | null
    watching: { openOrders: number; subscriptions: number }
    burn?: { state: string; why: string | null; availableUsdg: string | null }
  }
  levels: { motifsPriced: number; pointsRecorded: number; secondsSinceSweep: number | null }
  chain: { router: string; rebalancer: string; orders: string; factory: string | null; burner?: string | null }
}

/**
 * What a Motif contract could conceivably be left holding: every stock with a
 * pool, and the dollar they are bought with. Thirteen tokens.
 */
const HELD = [
  ...tokenList.map((t) => ({ address: t.address, symbol: t.symbol })),
  { address: addresses.usdg, symbol: 'USDG' },
]

type Contract = { name: string; address: `0x${string}`; does: string }

/**
 * The contracts that make up the protocol, and none that hold stock on purpose.
 *
 * Basket token vaults are left out deliberately, and the page says so: a vault
 * exists to hold the stock behind its token, so a zero there would be the
 * failure rather than the proof.
 */
const CONTRACTS: Contract[] = [
  { name: 'Router', address: addresses.basketRouter, does: 'publishes motifs, and buys and sells them' },
  { name: 'Rebalancer', address: addresses.rebalancer, does: 'keeps a subscribed wallet in ratio, by allowance' },
  { name: 'Orders', address: addresses.orders, does: 'limits, stops and TWAPs, filled from the owner wallet' },
  ...(factoryAddress ? [{ name: 'Factory', address: factoryAddress, does: 'launches basket tokens' }] : []),
  ...(swapAddress ? [{ name: 'TokenSwap', address: swapAddress, does: 'lets a wallet trade a basket token pool' }] : []),
  { name: 'Burner', address: BURNER_ADDRESS, does: 'spends the protocol fee on MOTIF and burns it' },
]

const addrLink = (a: string, label?: string) => (
  <a href={`${EXPLORER}/address/${a}`} target="_blank" rel="noopener">
    {label ?? short(a)}
  </a>
)

const ago = (s: number | null | undefined) => (s === null || s === undefined ? READING : `${s}s ago`)
const pctOf = (bps: number, places: number) => `${(bps / 100).toFixed(places)}%`

function Tile({ k, v, n, tone }: { k: string; v: ReactNode; n: ReactNode; tone?: 'ok' | 'bad' }) {
  return (
    <div className="card feature proof-tile">
      <div className="proof-k num">{k}</div>
      <div className={`proof-v${tone ? ` proof-${tone}` : ''}`}>{v}</div>
      <div className="proof-n">{n}</div>
    </div>
  )
}

/**
 * The whole system, in public.
 *
 * @dev Every figure is read while the visitor looks at it: balances and the
 *      fee constants straight off the chain in their own browser, freshness,
 *      the keeper and the prices from the running api. Nothing is typed in,
 *      and most of it can fail in public, which is the point. A page that
 *      could only ever look good would prove nothing.
 *
 *      The balances are one multicall rather than one call each. Six
 *      contracts by thirteen tokens is seventy eight reads, on every refresh,
 *      from every visitor, against a public rpc that refuses bursts, and
 *      Multicall3 is deployed on this chain at its usual address.
 */
export function Proof() {
  const q = { refetchInterval: REFRESH }

  const balances = useReadContracts({
    allowFailure: true,
    contracts: CONTRACTS.flatMap((c) =>
      HELD.map((t) => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [c.address] as const })),
    ),
    query: q,
  })

  const extras = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: addresses.basketRouter, abi: basketRouterAbi, functionName: 'PROTOCOL_FEE_BPS' },
      { address: addresses.basketRouter, abi: basketRouterAbi, functionName: 'MAX_CREATOR_FEE_BPS' },
      { address: addresses.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [FEE_WALLET] },
    ],
    query: q,
  })

  const head = useBlockNumber({ query: q })
  const { data: status, error: apiError } = useApi<Status>('/v1/status', REFRESH)

  // Per contract, what it holds and what could not be read, in token order.
  const rows = CONTRACTS.map((c, ci) => {
    const held: string[] = []
    let unread = 0
    HELD.forEach((t, ti) => {
      const r = balances.data?.[ci * HELD.length + ti]
      if (!r || r.status !== 'success') unread++
      else if ((r.result as bigint) > 0n) held.push(t.symbol)
    })
    return { ...c, held, unread }
  })
  const reads = CONTRACTS.length * HELD.length
  const answered = balances.data?.filter((r) => r.status === 'success').length ?? 0
  const nonZero = rows.reduce((n, r) => n + r.held.length, 0)

  const protocolBps = extras.data?.[0]?.status === 'success' ? Number(extras.data[0].result) : null
  const creatorBps = extras.data?.[1]?.status === 'success' ? Number(extras.data[1].result) : null
  const waiting = extras.data?.[2]?.status === 'success' ? (extras.data[2].result as bigint) : null

  const behind =
    head.data !== undefined && status ? Math.max(0, Number(head.data) - status.indexer.lastBlock) : null

  // The site is built with its addresses and the api indexes with its own.
  // If those ever drifted apart, the site would be quietly showing one set of
  // contracts and trading against another.
  const pairs: [string, string | null | undefined, string | null][] = status
    ? [
        ['router', status.chain.router, addresses.basketRouter],
        ['rebalancer', status.chain.rebalancer, addresses.rebalancer],
        ['orders', status.chain.orders, addresses.orders],
        ['factory', status.chain.factory, factoryAddress],
        ['burner', status.chain.burner, BURNER_ADDRESS],
      ]
    : []
  const compared = pairs.filter(([, api, site]) => api && site)
  const disagree = compared.filter(([, api, site]) => api!.toLowerCase() !== site!.toLowerCase()).map(([k]) => k)

  return (
    <section className="view" style={{ paddingTop: 0 }}>
      {/* ------------------------------------------------------------ hero */}
      <div className="wrap hero solo">
        <div>
          <div className="eyebrow num">Proof · read live</div>
          <h1>
            The whole system,
            <br />
            in public.
          </h1>
          <p className="lede">
            Every contract address, and every number the site knows about itself, read from the chain
            or from the running api while you look at it. Nothing on this page is typed in by hand.
          </p>
          <p className="lede">
            Most of it can fail in public, and that is the point. A page that could only ever look good
            would prove nothing.
          </p>
          <div className="hero-note num">refreshes every 30 seconds</div>
        </div>
      </div>

      {/* ---------------------------------------------------------- custody */}
      <div className="wrap band">
        <div className="band-head">
          <h2>What the contracts hold</h2>
          <span className={`small num ${answered === reads && nonZero === 0 ? 'proof-ok' : 'dim'}`}>
            {balances.data === undefined
              ? `reading ${reads} balances`
              : `${answered} of ${reads} balances read · ${nonZero} not zero`}
          </span>
        </div>
        <p className="lede" style={{ marginTop: 0, maxWidth: '76ch' }}>
          Motif never holds your tokens: every leg is delivered straight to your wallet and the
          contracts have no withdrawal function. So each one below is asked for its balance of every
          stock with a pool and of USDG, and every line should read nothing, every time this page loads.
        </p>

        <div className="scroll-x" style={{ marginTop: 18 }}>
          <table className="wide-rows">
            <thead>
              <tr>
                <th>Contract</th>
                <th>Address</th>
                <th>What it does</th>
                <th>Holds</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td className="proof-addr">{addrLink(r.address)}</td>
                  <td className="dim">{r.does}</td>
                  <td className="num">
                    {balances.data === undefined ? (
                      <span className="dim">{READING}</span>
                    ) : r.held.length > 0 ? (
                      <span className="proof-bad">{r.held.join(', ')}</span>
                    ) : r.unread > 0 ? (
                      <span className="dim">{`${HELD.length - r.unread} of ${HELD.length} read, none held`}</span>
                    ) : (
                      <span className="proof-ok">{`nothing, 0 of ${HELD.length}`}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="notice" style={{ marginTop: 18 }}>
          <b>Basket token vaults are not on this list, on purpose.</b> A basket token is backed by real
          stock held in its own vault, which any holder can redeem from at any time. Those balances are
          meant to be there, and each token&apos;s page shows them.
        </div>
      </div>

      {/* ------------------------------------------------------ live numbers */}
      <div className="wrap band">
        <h2>Live numbers</h2>
        {apiError && !status && (
          <div className="notice bad" style={{ marginBottom: 16 }}>
            <b>The api is not answering right now.</b> The contract rows above come straight from the
            chain and are unaffected. The figures below need the api, so they say so rather than show
            something old.
          </div>
        )}
        <div className="cards3">
          <Tile
            k="Data freshness"
            v={behind === null ? READING : `${behind} ${behind === 1 ? 'block' : 'blocks'} behind`}
            n={status ? `The indexer last ran ${ago(status.indexer.secondsSinceRun)}.` : READING}
            tone={behind !== null && behind > 300 ? 'bad' : undefined}
          />
          <Tile
            k="The fee split"
            v={
              protocolBps === null || creatorBps === null
                ? READING
                : `${pctOf(protocolBps, 2)} · ${pctOf(creatorBps, 0)}`
            }
            n="To the protocol, and the most a creator can ever charge. Both are constants in the router, not settings anyone can turn up later."
          />
          <Tile
            k="Keeper"
            v={status ? status.keeper.state : READING}
            n={
              status ? (
                <>
                  {status.keeper.watching.openOrders} {status.keeper.watching.openOrders === 1 ? 'order' : 'orders'} open,{' '}
                  {status.keeper.watching.subscriptions} rebalancing.{' '}
                  {status.keeper.address && <>Runs as {addrLink(status.keeper.address)}.</>}
                </>
              ) : (
                READING
              )
            }
            tone={status ? (status.keeper.state === 'running' ? 'ok' : 'bad') : undefined}
          />
          <Tile
            k="Prices"
            v={status ? `${status.levels.motifsPriced} motifs` : READING}
            n={
              status
                ? `${status.levels.pointsRecorded.toLocaleString('en-US')} readings recorded, last repriced ${ago(status.levels.secondsSinceSweep)}.`
                : READING
            }
          />
          <Tile
            k="The burn"
            v={status?.keeper.burn ? status.keeper.burn.state : READING}
            n={
              <>
                {waiting === null ? READING : `${usdgPrecise(waiting.toString())} of fees waiting in `}
                {addrLink(FEE_WALLET, 'the fee wallet')}
                {status?.keeper.burn?.why ? `, ${status.keeper.burn.why}.` : '.'}{' '}
                <a href="/how">Tracked on how it works.</a>
              </>
            }
          />
          <Tile
            k="Site and indexer"
            v={!status ? READING : disagree.length === 0 ? 'agree' : 'disagree'}
            n={
              !status
                ? READING
                : disagree.length === 0
                  ? `The site and the indexer point at the same ${compared.map(([k]) => k).join(', ')}.`
                  : `They point at different ${disagree.join(', ')}, which is a misconfiguration worth reporting.`
            }
            tone={status ? (disagree.length === 0 ? 'ok' : 'bad') : undefined}
          />
        </div>
      </div>

      {/* --------------------------------------------------- other addresses */}
      <div className="wrap band">
        <h2>The other addresses</h2>
        <div className="scroll-x">
          <table className="wide-rows">
            <tbody>
              {[
                ['MOTIF token', TOKEN_ADDRESS, 'fixed supply, no mint function, burned by the burner'],
                ['USDG', addresses.usdg, 'the dollar every motif is bought with'],
                ['Fee wallet', FEE_WALLET, 'receives the 0.10% protocol fee, which the burner pulls from'],
                ...(status?.keeper.address
                  ? [['Keeper', status.keeper.address, 'fires orders and burns; holds only gas'] as const]
                  : []),
              ].map(([k, a, d]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="proof-addr">{addrLink(a, a)}</td>
                  <td className="dim">{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
