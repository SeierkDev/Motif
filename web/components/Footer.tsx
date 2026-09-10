import Link from 'next/link'
import { sourceUrl, tokenUrl, xUrl } from '@/lib/contracts'

/**
 * The bottom of every page.
 *
 * The risk notice is the reason this exists. Motifs hold tokenised equities,
 * which are not shares, and the price feeds behind them stop at the weekend.
 * Somebody who arrives from a shared link and buys in two clicks should not
 * have to go looking for that.
 */
export function Footer() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <div className="foot-col">
          <div className="foot-brand">Motif</div>
          <p>
            Launch an index of tokenised equities on Robinhood Chain. Your wallet submits every
            transaction and holds every token. Motif takes no custody of anything.
          </p>
        </div>

        <div className="foot-col">
          <div className="foot-h">Product</div>
          <Link href="/">Explore</Link>
          <Link href="/tokens">Basket tokens</Link>
          <Link href="/launch">Launch</Link>
          <Link href="/orders">Orders</Link>
          <Link href="/portfolio">Portfolio</Link>
          <Link href="/how">How it works</Link>
          <Link href="/proof">Proof</Link>
        </div>

        <div className="foot-col">
          <div className="foot-h">Source</div>
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener">
              Contracts and app on GitHub
            </a>
          )}
          <a href={tokenUrl} target="_blank" rel="noopener">
            MOTIF token on Pons
          </a>
          <a href={xUrl} target="_blank" rel="noopener">
            Updates on X
          </a>
        </div>

        <div className="foot-col">
          <div className="foot-h">Worth knowing</div>
          <p>
            Stock tokens are tokenised debt securities that track an equity. They give price
            exposure, not ownership or a vote. Prices can fall and a motif can lose value.
          </p>
          <p>
            The price feeds run while the market is open, so at a weekend there are no fresh prices
            and Motif says so rather than showing a stale one. The contracts are unaudited.
          </p>
        </div>
      </div>
    </footer>
  )
}
