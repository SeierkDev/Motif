'use client'

import { erc20Abi } from 'viem'
import { useReadContract } from 'wagmi'
import { activeChain } from '@/lib/chain'
import { ago, useApi, usdgPrecise } from '@/lib/api'
import { BURNER_ADDRESS, FEE_WALLET, TOKEN_ADDRESS, burnerAbi, sourceUrl } from '@/lib/contracts'

/** What MOTIF launched with. Fixed, and nothing can mint more. */
const LAUNCH_SUPPLY = 1_000_000_000n * 10n ** 18n
/** The burner's own minimum, in USDG's six decimals. Ten dollars. */
const MIN_BURN = 10_000_000n

const EXPLORER = activeChain.blockExplorers?.default.url ?? 'https://robinhoodchain.blockscout.com'

type Burn = { tx: string; logIndex: number; usdgIn: string; motifBurned: string; ts: number }
type Burns = { burner: string | null; burns: Burn[] }

/** Still being read. Shown instead of a zero, because unknown is not none. */
const READING = '…'

/** Whole tokens with separators. */
const whole = (raw: bigint) => (raw / 10n ** 18n).toLocaleString('en-US')

/**
 * The burn, tracked live.
 *
 * @dev Every figure in the card is read from the chain in the visitor's own
 *      browser rather than from the api: supply off the token, the running
 *      totals off the burner itself. That is the point of the section. A number
 *      the api served could be a number the api got wrong, and these are the
 *      ones anybody will quote. Only the list of recent burns comes from the
 *      api, because a list of past transactions is what an indexer is for, and
 *      every row links to the transaction so it can be checked all the same.
 *
 *      Thirty seconds between reads, the same as the paused check in the
 *      header. A burn is not a ticker.
 */
export function BurnBand() {
  const q = { refetchInterval: 30_000 }
  const supply = useReadContract({ address: TOKEN_ADDRESS, abi: erc20Abi, functionName: 'totalSupply', query: q })
  const burned = useReadContract({ address: BURNER_ADDRESS, abi: burnerAbi, functionName: 'motifBurned', query: q })
  const count = useReadContract({ address: BURNER_ADDRESS, abi: burnerAbi, functionName: 'burns', query: q })
  const spent = useReadContract({ address: BURNER_ADDRESS, abi: burnerAbi, functionName: 'usdgSpent', query: q })
  const waiting = useReadContract({ address: BURNER_ADDRESS, abi: burnerAbi, functionName: 'available', query: q })
  const { data: recent } = useApi<Burns>('/v1/burns?limit=5', 60_000)

  const sinceLaunch = supply.data === undefined ? undefined : LAUNCH_SUPPLY - supply.data
  // Parts per million, then to a percentage, so no float touches the supply.
  const share =
    sinceLaunch === undefined ? '' : `${(Number((sinceLaunch * 1_000_000n) / LAUNCH_SUPPLY) / 10_000).toFixed(4)}%`
  const toward = waiting.data === undefined ? undefined : waiting.data > MIN_BURN ? MIN_BURN : waiting.data
  const fill = toward === undefined ? 0 : Number((toward * 1000n) / MIN_BURN) / 10

  const rows: [string, string, boolean?][] = [
    ['MOTIF supply now', supply.data === undefined ? READING : whole(supply.data)],
    ['Burned since launch', sinceLaunch === undefined ? READING : `${whole(sinceLaunch)} · ${share}`, true],
    [
      'Burned from fees',
      burned.data === undefined || count.data === undefined
        ? READING
        : `${whole(burned.data)} in ${count.data} ${count.data === 1n ? 'burn' : 'burns'}`,
    ],
    ['Fees spent on burns', spent.data === undefined ? READING : usdgPrecise(spent.data.toString())],
  ]

  return (
    <div className="wrap band">
      <div className="split">
        <div>
          <h2>The burn</h2>
          <p className="lede" style={{ marginTop: 0 }}>
            The protocol keeps 0.10% of every buy, and all of it is spent buying MOTIF and burning it.
            A contract does it, with no owner and no withdrawal, so nothing that reaches it can go
            anywhere else.
          </p>
          <p className="dim" style={{ lineHeight: 1.7, marginTop: 14 }}>
            A burn fires whenever $10 of fees is waiting and spends $50 at most, so gas never eats it
            and it is never worth attacking. Every number here is read from the chain while you look
            at it, not typed in by us.
          </p>
          <div className="burn-links">
            <a href={`${EXPLORER}/address/${BURNER_ADDRESS}`} target="_blank" rel="noopener">
              The burner contract
            </a>
            <a href={`${EXPLORER}/address/${FEE_WALLET}`} target="_blank" rel="noopener">
              The fee wallet
            </a>
            {sourceUrl && (
              <a href={`${sourceUrl}/blob/main/src/MotifBurner.sol`} target="_blank" rel="noopener">
                The code
              </a>
            )}
          </div>
        </div>

        <div className="card calc burn-card">
          {rows.map(([k, v, up]) => (
            <div className="calc-row" key={k}>
              <span className="dim small">{k}</span>
              <span className={up ? 'num up' : 'num'}>{v}</span>
            </div>
          ))}
          <div className="calc-row">
            <span className="dim small">Waiting for the next burn</span>
            <span className="num">
              {toward === undefined ? READING : `${usdgPrecise(toward.toString())} of $10.00`}
            </span>
          </div>
          <div className="burn-meter" aria-hidden="true">
            <span style={{ width: `${fill}%` }} />
          </div>
          <div className="dim small" style={{ marginTop: 14, lineHeight: 1.6 }}>
            Since launch includes the dev allocation, burned on day one.
          </div>
        </div>
      </div>

      <div className="burn-list">
        <div className="feature-t">Recent burns</div>
        {recent === null ? (
          <div className="dim small burn-empty">{READING}</div>
        ) : recent.burns.length === 0 ? (
          <div className="dim small burn-empty">
            No burn yet. The first one fires once $10 of fees is waiting, and it will be listed here
            with its transaction.
          </div>
        ) : (
          recent.burns.map((b) => (
            <a
              className="burn-row"
              key={`${b.tx}:${b.logIndex}`}
              href={`${EXPLORER}/tx/${b.tx}`}
              target="_blank"
              rel="noopener"
            >
              <span>
                <span className="num up">{whole(BigInt(b.motifBurned))} MOTIF</span>
                <span className="dim"> burned with {usdgPrecise(b.usdgIn)} of fees</span>
              </span>
              <span className="dim small">{ago(b.ts)}</span>
            </a>
          ))
        )}
      </div>
    </div>
  )
}
