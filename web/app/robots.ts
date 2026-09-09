import type { MetadataRoute } from 'next'
import { SITE } from '@/lib/meta'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Nothing secret, just nothing useful: it is empty without a wallet
      // connected, so every crawl of it indexes an empty page.
      disallow: '/portfolio',
    },
    sitemap: `${SITE}/sitemap.xml`,
  }
}
