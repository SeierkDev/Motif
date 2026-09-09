// The message a creator signs lives in two places, and they have to agree.
//
// The api recovers an address from the signature by hashing the text it builds
// itself. The web builds the same text for the wallet to sign. If either one
// changes by a character, every recovery lands on some unrelated address and
// the api answers "that signature is not from <creator>" for a signature that
// is perfectly valid. Nothing throws on either side, so the only symptom is
// that attaching a picture stops working, which is exactly the kind of failure
// that survives a review.
//
// They cannot share a module: one is a node service, the other is a 'use
// client' bundle that imports the wagmi graph. So they are compared instead.
//
//   node scripts/check-picture-message.mjs
import { readFileSync } from 'node:fs'

const files = {
  api: 'api/src/server.ts',
  web: 'web/lib/api.ts',
}

/** The template literal `pictureMessage` returns, taken from the source. */
function template(path) {
  const src = readFileSync(path, 'utf8')
  const fn = src.indexOf('export function pictureMessage(')
  if (fn === -1) throw new Error(`no pictureMessage in ${path}`)
  const ret = src.indexOf('return `', fn)
  if (ret === -1) throw new Error(`no template returned in ${path}`)
  const start = ret + 'return `'.length
  const end = src.indexOf('`', start)
  if (end === -1) throw new Error(`unterminated template in ${path}`)
  return src.slice(start, end)
}

const api = template(files.api)
const web = template(files.web)

if (api !== web) {
  console.error('The signed message differs between the api and the web.')
  console.error(`  ${files.api}\n    ${JSON.stringify(api)}`)
  console.error(`  ${files.web}\n    ${JSON.stringify(web)}`)
  console.error('Every signature will be refused until these match exactly.')
  process.exit(1)
}

// It has to carry both facts, or a signature is replayable onto another motif
// or reusable for another picture.
for (const part of ['${indexId}', '${image}']) {
  if (!api.includes(part)) {
    console.error(`The signed message does not include ${part}, so it can be replayed.`)
    process.exit(1)
  }
}

console.log(`[picture] the api and the web sign the same message: ${JSON.stringify(api)}`)
