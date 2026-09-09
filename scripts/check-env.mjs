/*
 * Every NEXT_PUBLIC_ the site reads must be declared in web/Dockerfile.
 *
 * Next inlines these at build time, so one that exists only as a run time
 * variable on the platform is already too late: the built bundle carries the
 * default and the site behaves as though the value were never set. Nothing
 * errors. `NEXT_PUBLIC_SWAP` unset means the token page quietly says there is
 * no market rather than offering the trade panel, and `NEXT_PUBLIC_SOURCE_URL`
 * unset means the header quietly has no source link. Both of those are
 * deliberate fallbacks for "not configured", which is exactly what makes the
 * failure invisible: the site looks fine and is wrong.
 *
 * That is what happened. Both were documented in CLAUDE.md as variables the
 * site takes, read by the code, and absent from the image, so setting either on
 * the platform did nothing at all.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

/* Dev only, and deliberately not settable on a built image: it points the site
   at a fresh anvil's deterministic addresses, which on a real deployment is a
   healthy looking site wired to contracts that do not exist. */
const DEV_ONLY = new Set(['NEXT_PUBLIC_LOCAL'])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full)
  }
  return out
}

/*
 * Comments are stripped first. A doc comment explaining the rule mentions
 * `process.env.NEXT_PUBLIC_X` as a placeholder, and counting that as a read had
 * this script demanding an ARG for a variable that does not exist.
 *
 * Line comments are only stripped when they start the line, so a `//` inside a
 * url in real code is left alone.
 */
const decomment = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const read = new Set()
for (const file of ['app', 'lib', 'components'].flatMap((d) => walk(join(ROOT, 'web', d)))) {
  for (const m of decomment(readFileSync(file, 'utf8')).matchAll(
    /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]+)/g,
  )) {
    read.add(m[1])
  }
}

const dockerfile = readFileSync(join(ROOT, 'web/Dockerfile'), 'utf8')
const declared = new Set(
  [...dockerfile.matchAll(/^ARG (NEXT_PUBLIC_[A-Z0-9_]+)$/gm)].map((m) => m[1]),
)
const forwarded = new Set(
  [...dockerfile.matchAll(/^ENV (NEXT_PUBLIC_[A-Z0-9_]+)=\$\1$/gm)].map((m) => m[1]),
)

const problems = []
for (const name of [...read].sort()) {
  if (DEV_ONLY.has(name)) {
    if (declared.has(name)) problems.push(`${name} is dev only and must not be an ARG in the image`)
    continue
  }
  if (!declared.has(name)) problems.push(`${name} is read by the site but has no ARG in web/Dockerfile`)
  else if (!forwarded.has(name)) problems.push(`${name} has an ARG but no matching ENV, so the build never sees it`)
}

/* An ARG for something nothing reads is a variable somebody will set and watch
   do nothing, which is the same failure pointed the other way. */
for (const name of [...declared].sort()) {
  if (!read.has(name)) problems.push(`${name} is declared in web/Dockerfile but nothing reads it`)
}

if (problems.length) {
  console.error('web/Dockerfile and the site disagree about build time variables:\n')
  for (const p of problems) console.error(`  ${p}`)
  console.error('\nNext inlines NEXT_PUBLIC_ at build time, so an undeclared one cannot be set at all.')
  process.exit(1)
}

console.log(`ok: ${read.size - DEV_ONLY.size} build time variables, all declared and forwarded`)
