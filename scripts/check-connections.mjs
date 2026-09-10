/*
 * How the api treats connections, measured from outside it.
 *
 * No route test sees any of this, because every one of them opens a
 * connection, asks, and leaves. What goes wrong here goes wrong to connections
 * that stay:
 *
 *   - A live feed client that goes silent without closing, which is a tab
 *     behind a closed laptop lid, has to be dropped. The server used to ping
 *     every thirty seconds and never check for an answer, so five such clients
 *     were all still counted, and sent every broadcast, seventy five seconds
 *     and two pings after they went quiet.
 *   - A live client that answers its pings must not be dropped by the fix.
 *   - An idle kept-alive connection has to outlast the proxy in front. Node's
 *     default closed it at five seconds, which races a proxy reusing it and
 *     comes out as an intermittent 502.
 *
 * Run against an api started with a short heartbeat, or the first check waits
 * a minute:
 *
 *   MOTIF_WS_HEARTBEAT_MS=1000 node scripts/check-connections.mjs [base]
 */
import crypto from 'node:crypto'
import net from 'node:net'
import { createRequire } from 'node:module'

// `ws` is the api's dependency rather than the repository's, and the job that
// runs this has installed it there.
const require = createRequire(new URL('../api/package.json', import.meta.url))
const WebSocket = require('ws')

const base = process.argv[2] ?? process.env.MOTIF_API ?? 'http://127.0.0.1:8787'
const { hostname, port } = new URL(base)
const HEARTBEAT = Number(process.env.MOTIF_WS_HEARTBEAT_MS ?? 30_000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let bad = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ok   ${name}`)
  else {
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
    bad++
  }
}

// A query string no other caller uses, so a response held by the api's
// five second cache cannot answer for a count that has since changed.
const subscribers = async () => {
  const r = await fetch(`${base}/v1/status?c=${Date.now()}${Math.random()}`)
  return (await r.json()).subscribers
}

/** Complete the websocket handshake over a bare socket, then go silent. */
async function silentClient() {
  const s = net.connect(Number(port), hostname)
  s.on('error', () => {})
  await new Promise((r) => s.once('connect', r))
  s.write(
    `GET /v1/stream HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n` +
      `Sec-WebSocket-Version: 13\r\n\r\n`,
  )
  await new Promise((r) => s.once('data', r))
  // Never read again and never answer a ping, from here on.
  s.pause()
  return s
}

console.log(`connections, against ${base}, heartbeat ${HEARTBEAT}ms`)

const before = await subscribers()

// A client that behaves: the ws library answers every ping by itself.
const live = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/stream`)
await new Promise((r, j) => { live.once('open', r); live.once('error', j) })

const silent = []
for (let i = 0; i < 3; i++) silent.push(await silentClient())
await sleep(200)
check('the server counts every client that connected', (await subscribers()) === before + 4)

// Two heartbeats is the longest a dead client may be kept; a little over three
// leaves room for timers on a busy runner without letting the old behaviour,
// which never dropped them at all, pass.
await sleep(HEARTBEAT * 3 + 500)
const after = await subscribers()
check(
  'silent clients are dropped within two heartbeats',
  after === before + 1,
  `expected ${before + 1} (the live client), counted ${after}`,
)
check('a client that answers its pings is kept', live.readyState === WebSocket.OPEN)
live.close()
for (const s of silent) s.destroy()

// Idle keep-alive: one request, then nothing, for longer than Node's default.
const k = net.connect(Number(port), hostname)
k.on('error', () => {})
await new Promise((r) => k.once('connect', r))
k.write(`GET /healthz HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: keep-alive\r\n\r\n`)
await new Promise((r) => k.once('data', r))
let closedAt = null
const idleFrom = Date.now()
k.once('close', () => { closedAt = Date.now() })
await sleep(6_500)
check(
  'an idle kept-alive connection outlasts the five second default',
  closedAt === null,
  `the server closed it after ${closedAt === null ? '?' : ((closedAt - idleFrom) / 1000).toFixed(1)}s`,
)
k.destroy()

console.log(bad ? `\n${bad} failed` : '\nconnections behave')
process.exit(bad ? 1 : 0)
