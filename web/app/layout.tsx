import './globals.css'
import type { Metadata } from 'next'
import { Providers } from './providers'
import { Header } from '@/components/Header'
import { HashRedirect } from '@/components/HashRedirect'
import { Footer } from '@/components/Footer'
import { SITE } from '@/lib/meta'
import { THEME_BOOT } from '@/lib/theme'

const description =
  'Launch an index of tokenised equities in one transaction and earn a fee on every purchase. Buyers hold the real tokens in their own wallet, and can sell the whole basket back in one transaction.'

export const metadata: Metadata = {
  // Absolute urls come from here. Without it every Open Graph tag is relative,
  // which unfurlers treat as no tag at all, silently.
  metadataBase: new URL(SITE),
  title: {
    default: 'Motif',
    // Every page carries its own name and the site's, so a tab full of motifs
    // is readable rather than eight tabs all called Motif.
    template: '%s | Motif',
  },
  description,
  applicationName: 'Motif',
  openGraph: {
    type: 'website',
    siteName: 'Motif',
    title: 'Motif',
    description,
    url: SITE,
    // The default card for every page that does not draw its own. A motif page
    // generates one from its holdings and overrides this; the home page, the
    // grid, launch, orders and how it works had no image at all until now, so
    // every one of those links unfurled as a bare grey rectangle.
    images: [{ url: '/banner.png', width: 1280, height: 640, alt: 'Motif' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Motif',
    description,
    images: ['/banner.png'],
  },
  robots: { index: true, follow: true },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Dark is what the server renders and the default. The script applies a
    // saved light choice before the first paint, which is also why the root
    // is allowed to differ from the server's markup on this one attribute.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>
        <Providers>
          <HashRedirect />
          <Header />
          {children}
          <Footer />
        </Providers>
      </body>
    </html>
  )
}
