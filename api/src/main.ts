import { open } from './db.js'
import { burnerProblem, factoryProblem, Indexer, parseFromBlock, type Event } from './indexer.js'
import { createApi } from './server.js'
import { Keeper } from './keeper.js'
import { Levels } from './levels.js'
import { rebuildTotals } from './totals.js'

const PORT = Number(process.env.PORT ?? 8787)
const DATA = process.env.DATA_DIR ?? './data'

const db = open(`${DATA}/motif.sqlite`)

// The running totals the aggregating routes read, rebuilt from the rows on
// every boot so nothing in them can outlive a restart. See totals.ts.
const rebuilt = rebuildTotals(db)
console.log(`[totals] rebuilt from ${rebuilt.buys} buys in ${rebuilt.ms}ms`)

// The broadcaster does not exist until the api is built, and the indexer needs
// somewhere to send events, so it starts out pointing at a stub.
let broadcast: (e: Event) => void = () => {}
const indexer = new Indexer(db, (e) => broadcast(e))
const keeper = new Keeper(db)
const levels = new Levels(db)
const api = createApi(db, indexer, keeper, levels, PORT)
broadcast = api.broadcast

/**
 * Shutdown is wired up here, before the first `await`, and that placement is
 * the whole point.
 *
 * @dev **It used to be at the bottom of this file, under
 *      `await indexer.start(...)`.** A top level await does not just delay the
 *      lines after it, it delays them for as long as the await takes, and this
 *      one is a chain scan against an rpc that this project's own notes
 *      describe as refusing service under load. Until it resolved there was no
 *      handler at all, so a stop during the scan was the default: killed, no
 *      database close, no server close.
 *
 *      Measured rather than reasoned about. Booted against an unreachable rpc
 *      so the scan hangs, sent SIGTERM, and the process exited **143**, which
 *      is 128 plus 15, killed by signal, with none of this running. Moved
 *      above the await and the same test exits 0 after printing the line
 *      below.
 *
 *      **That was half of it, and the other half is the entrypoint.** A
 *      handler cannot run in a process the signal never reaches, and any
 *      wrapper that stays alive in front of node swallows it. Measured across
 *      every shape this is started in:
 *
 *          npm start, "tsx src/main.ts"        143, no shutdown
 *          npm start, "exec tsx src/main.ts"     0, clean
 *          npx tsx src/main.ts                 143, no shutdown
 *          node_modules/.bin/tsx src/main.ts     0, clean
 *          node --import tsx src/main.ts         0, clean
 *
 *      So `exec` in the npm script, which replaces the shell rather than
 *      leaving it in the middle, and `node --import tsx` in the Dockerfile
 *      rather than `npx`. The tsx bin shim is fine: it forks a second node,
 *      the process tree shows both, and it forwards the signal correctly.
 *
 *      The deploy log that started this said `npm error signal SIGTERM` under
 *      a healthy `[api] listening on 8787`, which reads like the service
 *      falling over on boot and is not: it is the previous container being
 *      retired by the deploy replacing it. It should still read as what it is.
 *
 *      `stop()` on all three is a `clearTimeout` on a timer that may be null,
 *      so calling them before `start()` is safe and that is why this can sit
 *      up here at all.
 */
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`[motif] ${sig}, shutting down`)
    indexer.stop()
    keeper.stop()
    levels.stop()
    api.server.close()
    db.close()
    process.exit(0)
  })
}

// A local fork starts at the block it forked from, so scanning the default
// window would replay 200,000 blocks of upstream history for nothing.
//
// Parsed rather than handed straight to BigInt(), which throws on anything
// that is not a number. This is top level code that runs after the http server
// is created but before it is answering, so that throw killed the process on
// boot and the deploy failed as a healthcheck timeout.
const from = parseFromBlock(process.env.MOTIF_FROM_BLOCK)
const warnings = [from.problem, factoryProblem(), burnerProblem()].filter((w): w is string => w !== null)
if (warnings.length > 0) {
  indexer.configWarning = warnings.join('; ')
  for (const w of warnings) console.warn(`[indexer] ${w}`)
}
await indexer.start(from.value)
keeper.start()
levels.start()
console.log(`[motif] indexing from block ${indexer.cursor}`)
