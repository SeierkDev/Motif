'use client'

import Link from 'next/link'
import { tokenList, symbolOf } from '@/lib/contracts'
import { BurnBand } from './BurnBand'

/* The stats strip moved to the home page, where a visitor actually sees it.
   It was here, below the fold, on the page fewest people open. */
export function About() {

  return (
    <section className="view" style={{ paddingTop: 0 }}>
      {/* ------------------------------------------------------------ hero */}
      <div className="wrap hero solo">
        <div>
          <div className="eyebrow num">Robinhood Chain · tokenised equities</div>
          <h1>
            Anyone can launch
            <br />
            an index fund.
          </h1>
          <p className="lede">
            Pick real stocks, set the weights, name it and publish. Anyone can buy the whole basket
            in one transaction, and you earn a fee on every purchase for as long as it exists.
          </p>
          <p className="lede">
            The tokens land in the buyer&apos;s own wallet. No vault, no share class, nothing to
            redeem. Motif cannot take them because it never has them.
          </p>
          <p className="lede">
            That is a motif. There is a second thing you can launch here, a basket token, which does
            hold the stock so that the token can trade on its own. The difference is the next
            section, and it is worth reading before you pick one.
          </p>

          <div className="hero-cta">
            <Link className="btn" href="/launch">
              Launch a motif
            </Link>
            <Link className="btn ghost" href="/tokens/new">
              Launch a basket token
            </Link>
          </div>

          <div className="hero-note num">
            one transaction in · one transaction out · no fee to leave
          </div>
        </div>

      </div>

      {/* ---------------------------------------------------- how it works */}
      <div className="wrap band">
        <h2>How it works</h2>
        <div className="steps">
          {[
            {
              n: '01',
              t: 'Pick the holdings',
              d: 'Choose from the real tickers that trade on this chain and set what share each one takes. The weights have to add to 100%, and the form will not let you publish until they do.',
            },
            {
              n: '02',
              t: 'Publish it, and buy your own',
              d: 'One transaction writes it on chain and buys your first slice, so it arrives with real volume rather than as an empty row. It can never be edited afterwards.',
            },
            {
              n: '03',
              t: 'Anyone buys the whole thing at once',
              d: 'Every leg swaps on Uniswap V3 and goes straight to the buyer. If any leg cannot fill above the minimum they set, the whole purchase is cancelled rather than leaving a partial basket.',
            },
            {
              n: '04',
              t: 'You earn on every purchase, forever',
              d: 'Your fee comes out of the buyer and reaches you in the same transaction. Nothing accrues in a contract, and there is nothing to claim later.',
            },
          ].map((s) => (
            <div className="step" key={s.n}>
              <div className="step-n num">{s.n}</div>
              <div className="step-t">{s.t}</div>
              <div className="step-d">{s.d}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------- the claim */}
      <div className="wrap band">
        <h2>What you actually hold</h2>
        <div className="cards3">
          <div className="card feature">
            <div className="feature-t">The tokens, in your own wallet</div>
            <p>
              There is no vault and no pooled balance. Each leg is swapped and delivered straight to
              you, so you hold the actual NVDA and TSLA rather than a claim on them. Nothing rests
              in these contracts between transactions, and that is checked on every test run against
              random sequences of buying and selling.
            </p>
          </div>
          <div className="card feature">
            <div className="feature-t">A way out, in one transaction</div>
            <p>
              Sell any part of a basket back to USDG in a single transaction, at no fee. The creator
              fee and the protocol fee are charged on the buy and nowhere else, because a fee for
              leaving would mean a creator earns when people go.
            </p>
          </div>
          <div className="card feature">
            <div className="feature-t">Stops that fire at a weekend</div>
            <p>
              Limit orders, stop losses, trailing stops and TWAP, triggered on the pool price rather
              than on an oracle. The pool never closes, so a stop still works on a Saturday while the
              exchange is shut and the price feeds have gone quiet.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ the two things */}
      <div className="wrap band">
        <h2>Two things you can launch</h2>
        <p className="lede" style={{ marginTop: 0, maxWidth: '76ch' }}>
          They are built out of the same stocks and they are not variations of each other. One never
          holds anything and cannot run on attention. The other holds the stock in a vault so that a
          token can trade against it, which is the only way to get the second half and is also what
          it costs.
        </p>

        {/* What actually happens, before the table that summarises it. The
            table alone was not enough: it says what the two are and never says
            what a buyer does, and a basket token is two stages that people
            reliably read as one. Asked three times in a row what the difference
            was, by somebody who had read this page. */}
        <div className="cards2" style={{ marginTop: 22 }}>
          <div className="card feature">
            <div className="feature-t">A motif is a shopping list</div>
            <p>
              You write a list of stocks and weights and you name it. Somebody spends $100 on it and
              one transaction buys $60 of NVDA and $40 of TSLA and sends them{' '}
              <b>to their own wallet</b>. There is no motif token, because there is nothing to hold a
              share of. They sell those stocks whenever they like, here or anywhere else on the
              chain, and this site cannot stop them or take a fee for it.
            </p>
            <p>
              You earn your fee, up to 1%, out of every purchase, for as long as the motif exists.
              What a motif cannot do is run: it is worth the weighted price of real stocks and
              nothing else.
            </p>
          </div>
          <div className="card feature">
            <div className="feature-t">A basket token is a fund with a share</div>
            <p>
              <b>First it raises.</b> You set a target, say $10,000. The token exists straight away
              and people buy it on a curve, so the earliest buyer pays the least and every buy moves
              the price up. The money sits in the curve and no stock has been bought yet. Anyone can
              sell back out along the curve at any time.
            </p>
            <p>
              <b>Then it graduates.</b> Once the target is met, anybody at all can trigger it, and
              one transaction spends 80% of the raise on the real stock into a vault and puts the
              other 20% into the token&rsquo;s own pool so it can be traded. From that moment every
              token is a claim on real stock, and any holder can redeem it for their share of what is
              in the vault, at any time, with no permission and no fee.
            </p>
            <p>
              That redemption is the floor. If the token ever traded below the stock behind it,
              anyone could buy it, redeem it, sell the stock and keep the difference, which is what
              drags the price back up. So the upside is whatever attention gives it and the downside
              is real equities rather than zero.
            </p>
          </div>
        </div>

        <div className="scroll-x" style={{ marginTop: 22 }}>
          <table className="wide-rows">
            <thead>
              <tr>
                <th />
                <th>Motif</th>
                <th>Basket token</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['What you get when you buy', 'The actual stock tokens, in your wallet', 'An ERC-20 token'],
                ['Is there a token', 'No. It is an index, and it has no supply', 'Yes, with its own Uniswap pool'],
                ['Who holds anything', 'Nobody, ever', 'A vault, which any holder can redeem from'],
                ['Can the price run', 'No. It is the weighted price of the stocks', 'Yes. It trades on its own'],
                ['Your downside', 'The stocks', 'The stocks, through redemption, which is below what a pool buyer paid'],
                ['How you get out', 'Sell the legs back, no fee', 'Sell it, or redeem it for the stock'],
                ['What the creator earns', 'A fee on every purchase, forever', "The pool's 0.3% on every trade, forever"],
              ].map(([k, a, b]) => (
                <tr key={k}>
                  <td className="dim">{k}</td>
                  <td>{a}</td>
                  <td>{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="notice" style={{ marginTop: 20 }}>
          <b>A basket token opens trading several times what it is backed by</b>, deliberately, so
          that the first trade is not immediately underneath the floor. The floor is real and it is
          what the stock is worth, which is not the same as what you paid: somebody who bought on
          the curve is much closer to it than somebody who bought in the pool afterwards. Every
          token page draws both lines so you can see the gap before you buy.
        </div>

        <p className="lede" style={{ marginTop: 20, maxWidth: '76ch' }}>
          <b>Why both.</b> A motif is the honest version and it gives a buyer no particular reason to
          be here: they spend $100, receive $100 of stock, and are no better off than buying the two
          legs themselves. A basket token gives them upside like any other launch with a floor made
          of real equities underneath it, which nothing that holds nothing can offer. The motif is
          the proof the mechanism works and takes no custody. The token is the one people will
          trade.
        </p>
      </div>

      {/* --------------------------------------------------------- tickers */}
      <div className="wrap band">
        <div className="band-head">
          <h2>What you can put in one</h2>
          <span className="dim small">{tokenList.length} with a live pool</span>
        </div>
        <div className="tickers">
          {tokenList.map((t) => (
            <div className="tick" key={t.address}>
              <div className="tick-sym num">{t.symbol}</div>
              <div className="tick-name">{t.name}</div>
            </div>
          ))}
        </div>
        <p className="dim small" style={{ marginTop: 18, lineHeight: 1.7, maxWidth: '72ch' }}>
          Found by walking the Uniswap V3 factory on this chain rather than taken from a list.
          Anything else trading here is a memecoin, and a basket cannot point at one: a leg with no
          real pool is refused at publication rather than at somebody&apos;s first buy.
        </p>
      </div>

      {/* -------------------------------------------------------- creators */}
      <div className="wrap band">
        <div className="split">
          <div>
            <h2>If you launch one</h2>
            <p className="lede" style={{ marginTop: 0 }}>
              You set your fee when you publish, up to 1%. It comes out of each buyer and is paid to
              you inside the same transaction, on every purchase, for as long as the motif exists.
            </p>
            <p className="dim" style={{ lineHeight: 1.7, marginTop: 14 }}>
              Capped at 1% on purpose, so a published index cannot be predatory and a buyer does not
              have to read the fine print before trusting one. Nothing is held back and there is no
              claim step. If nobody buys, you earn nothing. If somebody buys at three in the
              morning, it is in your wallet at three in the morning.
            </p>
            <div className="hero-cta">
              <Link className="btn" href="/launch">
                Launch a motif
              </Link>
            </div>
          </div>

          <div className="card calc">
            <div className="calc-row">
              <span className="dim small">Bought through your motif</span>
              <span className="num">$100,000</span>
            </div>
            <div className="calc-row">
              <span className="dim small">Your fee, at the 1% cap</span>
              <span className="num up">$1,000</span>
            </div>
            <div className="calc-row">
              <span className="dim small">Held by Motif at any point</span>
              <span className="num">$0</span>
            </div>
            <div className="calc-row">
              <span className="dim small">When you are paid</span>
              <span className="num">Same transaction</span>
            </div>
            <div className="notice" style={{ marginTop: 16 }}>
              An example, not a projection. What a motif earns depends entirely on whether anyone
              buys it.
            </div>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------ burn */}
      <BurnBand />

      {/* ------------------------------------------------------------- faq */}
      <div className="wrap band">
        <h2>Plain answers</h2>
        <div className="qa">
          {[
            {
              q: 'Are these real shares?',
              a: 'No. They are tokenised debt securities that track an equity, so they give price exposure rather than ownership or a vote. That is a real difference and it is worth knowing before you buy one.',
            },
            {
              q: 'What happens at a weekend?',
              a: 'The stock price feeds run while the market is open and update on price movement rather than on a clock, so at a weekend there are no fresh prices. Motif says so instead of showing a stale number as if it were live. The pools stay open, so buying, selling and stops still work.',
            },
            {
              q: 'Can Motif take my tokens?',
              a: 'No, and not as a promise: there is nowhere for them to sit. The contracts hold no balance between transactions and have no withdrawal function. A guardian can pause the machinery and cap how much one call may move, and cannot move anything.',
            },
            {
              q: 'A basket token has a vault. Can anybody take what is in it?',
              a: 'No, and it is a narrower claim than the one above, so it is worth stating exactly. The vault has no withdrawal function, no owner, no pause and no upgrade. Redeeming is unconditional and permissionless: any holder, any amount, any time, no fee. The pool the token trades in is seeded once and there is no code anywhere that can reduce it. What none of that promises is that the price cannot fall, because the stock behind it can.',
            },
            {
              q: 'Which one should I launch?',
              a: 'A motif if you want people to end up holding the stocks themselves and you want to earn on every purchase. A basket token if you want a token with a price of its own that can run, and you are willing to have a vault hold the stock so that it can. A motif cannot 100x on attention, because it is the stocks. A basket token can, and it can fall a long way to its floor as well.',
            },
            {
              q: 'What does it cost?',
              a: 'The creator fee, up to 1%, plus 0.1% to the protocol, both on the buy. The protocol share is spent buying MOTIF and burning it, by a contract with no owner and no withdrawal, and every burn is on chain. Selling costs nothing beyond the pool fee and the gas.',
            },
            {
              q: 'What if a stock splits?',
              a: 'Every stock token carries a multiplier that changes on a split or a dividend. A two for one split reads as a 50% crash to anything naive, and a rebalancer would sell the position into it, so Motif freezes rebalancing when a multiplier moves and only the holder can acknowledge it.',
            },
            {
              q: 'Can a creator change a motif after people buy in?',
              a: 'No, and neither can we. If weights could change after buyers arrived, a creator could wait for them and then repoint it at something worthless. Changing your mind means publishing a new one.',
            },
          ].map((x) => (
            <div className="qa-item" key={x.q}>
              <div className="qa-q">{x.q}</div>
              <div className="qa-a">{x.a}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ----------------------------------------------------------- close */}
      <div className="wrap">
        <div className="closer">
          <div className="closer-t">Launch one in about a minute.</div>
          <p className="dim" style={{ maxWidth: '52ch', lineHeight: 1.7, margin: '0 auto' }}>
            Pick the holdings, set the weights, name it. It costs one transaction, and it is yours
            for as long as it exists.
          </p>
          <div className="hero-cta" style={{ justifyContent: 'center' }}>
            <Link className="btn" href="/launch">
              Launch a motif
            </Link>
            <Link className="btn ghost" href="/">
              See what people launched
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}
