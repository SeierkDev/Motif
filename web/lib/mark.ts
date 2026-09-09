import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The real mark, as bytes a link card can draw.
 *
 * @remarks
 * Both cards drew the logo as three coloured rectangles, which is the same
 * mistake this project already made twice on the site itself: the artwork is
 * not a shape that can be approximated, its legs are cut on a slant and no
 * arrangement of boxes lands it. `web/public/logo.png` is the real thing and it
 * is what the header uses, so it is what a shared link should carry too.
 *
 * Read once, at module load, rather than per render. Null if it cannot be read
 * at all, and the card falls back to the bars rather than failing: a card is
 * not worth taking a page down for. Deliberately in its own file so that
 * `meta.ts`, which client code reaches, stays free of `node:fs`.
 */
function load(): string | null {
  try {
    const bytes = readFileSync(join(process.cwd(), 'public', 'logo.png'))
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

export const SITE_MARK = load()
