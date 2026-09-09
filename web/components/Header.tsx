'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount, useConnect, useDisconnect, useReadContract, useSwitchChain } from 'wagmi'
import { activeChain } from '@/lib/chain'
import { addresses, basketRouterAbi, sourceUrl, TOKEN_ADDRESS, tokenUrl, xUrl } from '@/lib/contracts'

const NAV = [
  { href: '/', label: 'Explore' },
  { href: '/tokens', label: 'Tokens' },
  { href: '/launch', label: 'Launch' },
  { href: '/orders', label: 'Orders' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/how', label: 'How it works' },
]

/**
 * The mark, from `web/public/logo.png`.
 *
 * @dev Drawn by hand as an SVG first, twice, and wrong both times: the real
 *      artwork is not a standard M. Its legs are cut on a slant rather than
 *      squared off, which no amount of tweaking a polygon was going to land.
 *      A logo is the last thing that should be an approximation, so this is the
 *      file itself.
 *
 *      `logo.png` rather than the uploaded `Motif.png`: that one is the mark
 *      on an opaque near black square, which is a black tile in the header and
 *      a black tile in every browser tab. This is the same artwork with the
 *      ground knocked out and cropped to the mark itself.
 *
 *      Cropping is most of why it looks bigger. The original is 739px square
 *      with the mark occupying 296 of that, so at a 28px box only about 11px
 *      was ink; at 40px cropped, all 40 are.
 *
 *      A plain `img` rather than `next/image`: it never changes and the
 *      optimiser's srcset and lazy loading buy nothing at this size.
 */
function Mark() {
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img className="mark-img" src="/logo.png" alt="Motif" width={40} height={40} />
}

/**
 * Connected to something that is not Robinhood Chain.
 *
 * @dev There was no chain handling at all, and the failure that causes is the
 *      quiet kind. A wallet left on Ethereum mainnet answers every read with
 *      whatever is at those addresses there, which is nothing, so the portfolio
 *      is empty, every quote fails and every button reverts, and not one of
 *      those says the word "network".
 *
 *      `switchChain` asks for `wallet_switchEthereumChain` and falls back to
 *      `wallet_addEthereumChain` when the wallet has never heard of the chain,
 *      which is the normal case here: this is an Orbit L2 nobody has by
 *      default. The chain object carries the rpc, the explorer and the native
 *      currency precisely so that add can succeed.
 */
function NetworkBanner() {
  /*
   * The wallet's chain, from `useAccount`, not `useChainId`.
   *
   * `useChainId()` reads the config's current chain, and the config lists only
   * Robinhood Chain, so it answered 4663 while the wallet sat on Ethereum and
   * this banner never rendered once. Caught by connecting a stub wallet that
   * reports chain 1 and watching for a banner that did not come.
   */
  const { isConnected, chainId } = useAccount()
  const { switchChain, isPending, error } = useSwitchChain()

  if (!isConnected || chainId === undefined || chainId === activeChain.id) return null
  return (
    <div className="paused">
      <b>Wrong network.</b> Your wallet is on chain {chainId}, and Motif is on{' '}
      {activeChain.name} ({activeChain.id}). Nothing here will work until you switch.{' '}
      <button className="linkish" onClick={() => switchChain({ chainId: activeChain.id })} disabled={isPending}>
        {isPending ? 'Switching' : `Switch to ${activeChain.name}`}
      </button>
      {error && <div className="small dim" style={{ marginTop: 6 }}>{error.message}</div>}
    </div>
  )
}

/** Three bars for closed, a cross for open, so the control says its own state. */
function Burger({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {open ? (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          d="M6 6l12 12M18 6L6 18"
        />
      ) : (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          d="M4 7h16M4 12h16M4 17h16"
        />
      )}
    </svg>
  )
}

/**
 * The guardian can pause the contracts. Without this a user meets a wall of
 * unexplained reverts on buying, launching and every order, and a deliberate
 * safety stop reads as a broken site.
 */
function PausedBanner() {
  const { data: paused } = useReadContract({
    address: addresses.basketRouter,
    abi: basketRouterAbi,
    functionName: 'paused',
    query: { refetchInterval: 30_000 },
  })
  if (!paused) return null
  return (
    <div className="paused">
      <b>Paused.</b> Buying and launching are stopped while something is looked at. Nothing of yours
      has moved: your tokens are in your own wallet and you can revoke any permission at any time.
    </div>
  )
}

export function Header() {
  const pathname = usePathname()
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

  /*
   * The six links do not fit on a phone, and wrapping them was worse than not
   * fitting. They used to drop to a full width third row that scrolled
   * sideways, which made the header two rows tall on every page, hid the last
   * items behind an edge with nothing to say they were there, and put a
   * horizontal scroll inside a vertically scrolling page.
   *
   * Open state lives here rather than in CSS because the menu has to close on
   * things CSS cannot see: navigating to the page you just picked, Escape, and
   * a tap anywhere else.
   */
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const barRef = useRef<HTMLElement>(null)

  /*
   * Every injected wallet the browser announced, deduplicated.
   *
   * The button used to call `connect({ connector: connectors[0] })`. wagmi
   * discovers wallets over EIP-6963 and appends each one it hears from, so
   * index zero is whichever extension announced itself first, not the one the
   * visitor wanted. With Phantom installed that is usually Phantom, and it
   * opened Phantom for somebody who wanted a different wallet. Reported from
   * the live site as "why would it redirect to Phantom on Robinhood Chain".
   *
   * Note that Phantom is a perfectly good answer on this chain: it has carried
   * Robinhood Chain natively since July 2026, behind a toggle in Settings and
   * Active Networks. The bug was never that it opened Phantom, it was that it
   * opened whatever announced first and called that a choice.
   *
   * Deduplicated by id because the generic `injected()` connector and the
   * EIP-6963 announcement of the same wallet are two entries for one thing.
   */
  const wallets = useMemo(() => {
    // The generic `injected()` connector is whatever `window.ethereum` happens
    // to be, which is one of the discovered wallets under a name that tells the
    // reader nothing. Measured with Phantom and MetaMask both announcing: the
    // menu offered "Injected", "Phantom", "MetaMask", and the first was
    // Phantom again. It stays as the only entry when nothing announced, since
    // a wallet that does not speak EIP-6963 is still a wallet.
    const announced = connectors.filter((c) => c.id !== 'injected')
    const list = announced.length > 0 ? announced : connectors

    const seen = new Set<string>()
    return list.filter((c) => {
      const key = (c.name || c.id).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [connectors])

  // Closing on the path is what makes it feel like a menu rather than a panel
  // you have to dismiss twice: tap a link, go there, menu is gone.
  useEffect(() => {
    setOpen(false)
    setPicking(false)
  }, [pathname])

  useEffect(() => {
    if (!open && !picking) return
    const shut = () => {
      setOpen(false)
      setPicking(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') shut()
    }
    const onDown = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) shut()
    }
    document.addEventListener('keydown', onKey)
    // Capture, so a tap that lands on something which stops propagation still
    // closes the menu rather than leaving it open over the page.
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open, picking])

  return (
    <>
    <PausedBanner />
    <NetworkBanner />
    <header className={open ? 'bar open' : 'bar'} ref={barRef}>
      {/* The row is a `.wrap` so it lines up with the page under it, while the
          band around it stays full bleed. See the note on `.bar` in globals. */}
      <div className="bar-in">
        <Link className="mark" href="/" aria-label="Motif home">
          <Mark />
        </Link>

        <nav id="nav">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={pathname === n.href ? 'on' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="bar-right">
          {/* Phone only, and it sits before the icons so the tap target nearest
              the thumb is the one that opens the menu. */}
          <button
            type="button"
            className="burger"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="nav"
            onClick={() => setOpen((v) => !v)}
          >
            <Burger open={open} />
          </button>

          {/* The token contract, on the bar rather than only in the footer.
              Truncated because 42 characters do not fit next to the nav, and
              carrying the full value on the title so it can still be read. */}
          <a
            className="ca"
            href={tokenUrl}
            target="_blank"
            rel="noopener"
            title={TOKEN_ADDRESS}
            aria-label={`MOTIF contract ${TOKEN_ADDRESS}`}
          >
            <span className="ca-k">CA</span>
            <span className="ca-v">{`${TOKEN_ADDRESS.slice(0, 6)}…${TOKEN_ADDRESS.slice(-4)}`}</span>
          </a>

          {/* Rendered only when there is somewhere real to point. See sourceUrl. */}
          {sourceUrl && (
            <a className="ico" href={sourceUrl} target="_blank" rel="noopener" aria-label="Source on GitHub">
              <svg viewBox="0 0 24 24">
                <path
                  fill="currentColor"
                  d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"
                />
              </svg>
            </a>
          )}
          <a className="ico" href={xUrl} target="_blank" rel="noopener" aria-label="Motif on X">
            <svg viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
              />
            </svg>
          </a>

          {isConnected ? (
            <button className="connect ghost" onClick={() => disconnect()} title={address}>
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </button>
          ) : (
            <div className="walletpick">
              <button
                className="connect"
                disabled={isPending || wallets.length === 0}
                aria-expanded={picking}
                onClick={() => {
                  // One wallet is not a choice, so it does not get a menu.
                  if (wallets.length === 1) connect({ connector: wallets[0] })
                  else setPicking((v) => !v)
                }}
              >
                {isPending ? (
                  'Connecting'
                ) : wallets.length === 0 ? (
                  'No wallet'
                ) : (
                  <>
                    {/* Two spans toggled by a media query rather than a width read
                        in JS, which would differ between the server render and the
                        first client render and hydrate wrong. */}
                    <span className="only-wide">Connect wallet</span>
                    <span className="only-narrow">Connect</span>
                  </>
                )}
              </button>

              {picking && wallets.length > 1 && (
                <div className="walletmenu">
                  {wallets.map((c) => (
                    <button
                      key={c.uid}
                      onClick={() => {
                        setPicking(false)
                        connect({ connector: c })
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {c.icon && <img src={c.icon} alt="" width={18} height={18} />}
                      <span>{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
    </>
  )
}
