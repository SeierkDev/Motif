import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'

/**
 * Every mixed case hex address in the TypeScript has to be correctly checksummed.
 *
 * viem rejects one whose checksum does not match, and it does it at call time
 * rather than at build time. So a wrong address is not a build error, it is a
 * page that throws for anybody who touches that token, with nothing anywhere
 * saying why. Seven of the twelve tickers in the site config were wrong, which
 * broke the whole portfolio page and any motif holding one of them. It survived
 * because the five that happened to be right were the five every test used.
 *
 * Solidity refuses to compile a bad checksum, which is why the contracts never
 * had this problem. This gives the TypeScript the same guarantee.
 *
 *   cd api && npx tsx src/check-addresses.ts
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOTS = ['web/lib', 'web/components', 'web/app', 'api/src', 'packages/sdk/src']
const EXT = /\.(ts|tsx|mjs|js)$/

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (EXT.test(name)) out.push(p)
  }
  return out
}

let bad = 0
let checked = 0
for (const rel of ROOTS) {
  let files: string[]
  try {
    files = walk(join(ROOT, rel))
  } catch {
    continue
  }
  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    for (const a of new Set(src.match(/0x[0-9a-fA-F]{40}/g) ?? [])) {
      // All lower or all upper carries no checksum to be wrong about.
      if (a === a.toLowerCase() || a === a.toUpperCase()) continue
      checked++
      let ok = false
      try {
        ok = getAddress(a) === a
      } catch {
        ok = false
      }
      if (!ok) {
        console.error(
          `${file.slice(ROOT.length + 1)}\n  bad checksum ${a}\n  should be    ${getAddress(a.toLowerCase())}`,
        )
        bad++
      }
    }
  }
}

console.log(
  bad
    ? `${bad} bad of ${checked} mixed case addresses`
    : `${checked} addresses, all correctly checksummed`,
)
process.exit(bad ? 1 : 0)
