# The Motif API

Open, keyless, wildcard CORS. Everything here is already public on chain, so a
key would only be theatre. What it would actually do is stop somebody building
against this without asking first, which is the opposite of the point.

Base url is wherever it runs. Locally that is `http://127.0.0.1:8787`.

## Routes

```
GET /v1/leaderboard?by=volume|fees|buys|new|return|worst&limit=50
GET /v1/trending?hours=24&limit=25
GET /v1/creators?limit=50
GET /v1/creators/:address
GET /v1/indexes?limit=50
GET /v1/indexes/:id
GET /v1/indexes/:id/buys
GET /v1/indexes/:id/history?limit=500
GET /v1/buys?limit=50&before=<block>:<logIndex>
GET /v1/sells?limit=50&before=<block>:<logIndex>
GET /v1/indexes/:id/sells
GET /v1/rebalances?limit=50
GET /v1/orders?owner=0x...
GET /v1/holders/:address
GET /v1/burns?limit=50
GET /v1/stats
GET /v1/status
GET /v1/curves?limit=60
GET /v1/curves/:curve
GET /v1/images/:sha256
POST /v1/images
GET /healthz
WS  /v1/stream
```

An unknown path returns 404 with this list in the body, so the API documents
itself to anyone who guesses wrong. `scripts/api-smoke.mjs` reads that same list
and calls every route on it, which is how a route that ships broken gets caught
rather than sitting unused until somebody integrates against it.

That runs in CI now, against a fixture database and a deliberately unreachable
rpc:

```bash
cd api && npx tsx src/fixture.ts /tmp/motif-fixture/motif.sqlite
DATA_DIR=/tmp/motif-fixture MOTIF_RPC=http://127.0.0.1:59999 npx tsx src/main.ts &
node scripts/api-smoke.mjs
```

The unreachable rpc is not a compromise, it is the stronger test. Every route
above reads SQLite and needs no chain, so if one of them quietly starts
depending on one, that job is where it shows up. The fixture is built by opening
a database through the ordinary migration path rather than with a hand written
schema, so it cannot drift from the server the first time a migration adds a
column.

## A motif

Every route that returns motifs returns the same shape, so a caller never has to
make a second request per row to find out whether one went up.

```json
{
  "id": 0,
  "creator": "0xf39fd6e5...",
  "creator_fee_bps": 50,
  "input": "0x5fc5360d...",
  "leg_count": 2,
  "block": 55313354,
  "tx": "0x55d0f0a5...",
  "name": "AI Core",
  "symbol": "AICORE",
  "description": "NVDA and TSLA, 60/40.",
  "ts": 1788630749,
  "buys": 2,
  "holders": 1,
  "lastBuyTs": 1788630749,
  "volume": "6000000000",
  "fees": "30000000",
  "performance": {
    "level": "100037769973727540356",
    "since": 1788629621,
    "changeBps": { "h1": null, "h24": null, "d7": null, "inception": 3 }
  },
  "legs": [
    { "position": 0, "token": "0xd0601ce1...", "fee": 500, "weight_bps": 6000 },
    { "position": 1, "token": "0x322f0929...", "fee": 3000, "weight_bps": 4000 }
  ]
}
```

`volume` and `fees` are **decimal strings, not numbers**. They are sums of 1e6
USDG amounts and they are summed with BigInt rather than through a double,
because `SUM(CAST(x AS REAL))` silently loses the low bits above 2^53. Parse
them with `BigInt`, not `Number`, if you intend to add them to anything.

`legs` are not carried in the `IndexCreated` event, because putting a dynamic
array in a log costs more than reading it back the once. The indexer reads
`legsOf` at ingest and stores them, so callers never pay for that.

### `performance`

`level` is the motif's value quoted against whatever it was worth when this
indexer first saw it, scaled by 1e18. Every motif starts at 100 on its own
launch day rather than against a shared epoch, which is the only thing that
makes two motifs launched months apart comparable.

**A null in `changeBps` means unknown, not flat.** A motif launched an hour ago
has no 24 hour figure, and a client that renders that as `0.00%` is inventing a
fact. `performance` itself is null when nothing has been recorded yet.

`since` is when recording started. It is not the launch block: if the indexer
was down for a day, the level series has a hole in it that nothing can fill
later, and `since` is how a caller can tell.

## `/v1/leaderboard`

```json
{ "by": "return", "indexes": [] }
```

`volume`, `fees`, `buys` and `new` sort in SQL. `return` and `worst` cannot:
return is computed from the level series rather than stored, so it is not a
column. Those two pull the top 500 rows, rank in process, and **drop every motif
with no reading yet** rather than sorting it into the middle as if it were flat.

## `/v1/trending`

Activity inside a window, so something launched this morning can outrank
something from last month. `hours` is capped at 720.

## `/v1/creators`

```json
{
  "creators": [
    {
      "creator": "0xf39fd6e5...",
      "launched": 2,
      "lastLaunchTs": 1788630752,
      "volume": "9000000000",
      "fees": "60000000"
    }
  ]
}
```

`/v1/creators/:address` returns `{ address, launched, feesEarned, indexes }`,
where `indexes` is the full motif shape above.

## `/v1/indexes/:id/history`

The recorded level series, newest first, with the same `performance` block.

```json
{
  "levels": [
    { "at": 1788632387, "level18": "100037769973727540356" },
    { "at": 1788632325, "level18": "100037769973727540356" }
  ],
  "performance": { "level": "...", "since": 1788629621, "changeBps": {} }
}
```

This is the one thing in the project that cannot be rebuilt. Volume and fees are
events and can be rescanned from the chain forever. A level is a reading of a
price that has already gone.

## `/v1/buys` and paging

```json
{
  "buys": [
    {
      "tx": "0x9114e565...",
      "log_index": 4,
      "index_id": 1,
      "buyer": "0xf39fd6e5...",
      "amount_in": "1500000000",
      "creator_fee": "15000000",
      "protocol_fee": "1500000",
      "block": 55313355,
      "ts": 1788630752
    }
  ],
  "next": "55313355:0"
}
```

Pass `next` back as `before` to get the following page. This is a keyset walk,
not an offset: on a live feed new buys land between requests, and an offset
would silently skip or repeat rows without ever erroring. `next` is null on the
last page.

**The cursor is a position, not a block.** It used to be the block number alone,
and two logs in one block is ordinary, so the next page began after the whole
block and whatever else was in it was unreachable by any cursor. Measured on the
CI fixture, which holds three buys with two of them in one block: walking it one
row at a time returned two. `log_index` is the index of the log within its
block, which makes the pair unique and totally ordered.

A bare block number is still accepted and still means "before this block", so a
client holding an older cursor keeps working. It simply cannot resolve a tie it
was never given the information for. Treat `next` as opaque and hand it back
unchanged.

## `/v1/sells`

The exits, paged exactly like `/v1/buys`.

```json
{
  "sells": [
    {
      "tx": "0x83735713...",
      "log_index": 8,
      "index_id": 0,
      "seller": "0xf39fd6e5...",
      "legs": 2,
      "amount_out": "1486548880",
      "block": 55353429,
      "ts": 1788634915
    }
  ],
  "next": null
}
```

`legs` is how many of the motif's legs the sale covered, since a seller may exit
part of a basket. `amount_out` is the quote asset received, and there are no fee
fields because nothing is charged on the way out.

Kept as its own feed rather than as signed amounts on `/v1/buys`. A buy has fees
and one input amount, a sale has neither and can cover any subset of the legs,
and folding them together would mean every volume query having to remember which
sign it wanted. `/v1/stats` reports `volumeIn` and `volumeOut` separately for
the same reason: netting them into one figure hides which one moved.

## `/v1/orders`

Open orders, or every order belonging to one address when `owner` is given.

```json
{
  "orders": [
    {
      "id": 0,
      "owner": "0xf39fd6e5...",
      "token": "0xd0601ce1...",
      "kind": 2,
      "amount": "1000000000000000000",
      "active": 1,
      "block": 55313360,
      "ts": 1788630800
    }
  ]
}
```

`kind` matches the enum in `Orders.sol`: `0` LimitBuy, `1` LimitSell, `2`
StopLoss, `3` TrailingStop, `4` Twap. Triggers and floors are not served here,
because they are on chain and authoritative there. Read `get(id)` for those.

## `/v1/status`

Reports the **indexer, keeper and levels**, not the web server. An http server
that answers while its indexer has been stuck for an hour is not healthy, and a
status endpoint that says `ok` in that state is worse than none.

```json
{
  "ok": true,
  "indexer": { "lastBlock": 55326076, "secondsSinceRun": 1, "error": null,
               "configError": null, "configWarning": null },
  "keeper": {
    "enabled": false,
    "address": null,
    "state": "no key",
    "keyError": null,
    "stoppedReason": null,
    "fired": 0,
    "secondsSinceSweep": null,
    "watching": { "openOrders": 0, "subscriptions": 0 },
    "recent": [
      { "at": 1788629621762, "kind": "order", "target": "0", "ok": 1,
        "detail": "filled", "tx": "0x979a5848..." }
    ]
  },
  "levels": {
    "secondsSinceSweep": 43, "motifsPriced": 2,
    "pointsRecorded": 280, "recordingSince": 1788629621, "error": null
  },
  "chain": { "rpc": "...", "router": "0x512F...", "rebalancer": "0x9fD1...",
             "orders": "0x987e..." },
  "migrations": ["001_indexes.sql"],
  "uptimeSeconds": 13,
  "subscribers": 0
}
```

**The api stays up when the chain does not.** An unreachable rpc used to take
the whole process down at boot, so a blip while deploying restart looped the
service and took every route with it, including the ones that read only SQLite.
It now starts, serves, and reports the problem here. That is the job of a status
endpoint: an http server that answers while its indexer is stuck is not healthy,
and it should still be up to tell you so.

`keeper.state` is the one to watch. `no key` means nothing will ever fire: no
stop loss, no limit, no rebalance. The keeper refuses to start rather than
pretending to work, and it stops after five consecutive failures with
`stoppedReason` set, because a keeper that has quietly given up looks exactly
like a market where nothing has triggered.

`bad key` is the same outage with a different cause: `MOTIF_KEEPER_KEY` was set
and was refused, with `keyError` saying what is wrong with the value. That one
used to be a crash rather than a state. A malformed key threw inside the Keeper
constructor, which runs before the http server binds, so the whole service died
on boot exactly the way an unreachable rpc used to, and the symptom was a
healthcheck timing out after five minutes rather than anything naming the key.
It is now the same bargain as the rpc: the service comes up, keeps serving reads
and keeps recording levels, and says here that it is not ok.

`keyError` never contains the key or any part of it. It reports a length, or
names a stray character from a short list of the ones a mangled paste actually
contains, and says nothing at all about any character outside that list.

Two mistakes are repaired rather than refused, because neither is ambiguous: a
value still wrapped in the quotes it was pasted with, and one that lost its `0x`
prefix. Both are logged at boot as something to go and fix, because a variable
that works by repair is one nobody corrects.

`keeper.burn` is the protocol fee burn, and it sits outside `keeper.state` on
purpose: a stopped burn is not a stopped keeper, and neither may hold the other
up. Its `state` is `no burner` without `MOTIF_BURNER`, `no key` without a keeper
key, `stopped` after five consecutive failures, and `watching` otherwise. `why`
is the contract's own answer, read every five minutes, to whether a burn would
go through; `the fee wallet has not approved this contract` and `under the ten
dollar minimum` are the two you will see most. A stopped burn makes `ok` false,
the same as a stopped keeper does.

`error` carries the last failure and is cleared on the next success, so a
flapping rpc is visible rather than smoothed away.

`configError` is separate from `error` because retrying will never fix it. It
names the variables that are not holding what they claim to: `MOTIF_ROUTER`,
`MOTIF_REBALANCER` and `MOTIF_ORDERS` are filled in from a deploy, so until one
has happened they hold a placeholder, and viem does not catch that. It hands
the string to the rpc rather than checking it, so a placeholder address is not
a startup error, it is an indexer that fails every pass forever. When one is
set the indexer does not scan and does not poll, and `ok` is false.

There is no falling back to the defaults compiled into `indexer.ts`. Those are
the deterministic addresses of a fresh anvil, which is right locally and wrong
on any real network. Indexing them anyway would leave a service that is
healthy, empty and reading an address with no contract on it, which is
indistinguishable from a launchpad nobody has used.

`configWarning` is the other half: a variable that was wrong and was safely
ignored. Only `MOTIF_FROM_BLOCK` does this, because the default window is the
documented right answer in production and the variable exists only to make a
first sync faster. A bad value costs a longer scan, not a wrong index, so `ok`
stays true. It used to cost rather more: the value went straight to `BigInt()`
at the top level of `main.ts`, which throws on anything that is not a number,
before the http server was answering. A placeholder there killed the process on
boot and the deploy failed as a healthcheck timing out after five minutes.

## `/v1/burns`

Every burn of the protocol fee, newest first, and what they add up to.

```json
{
  "burner": "0x...",
  "totals": { "burns": 2, "usdgIn": "75000000", "motifBurned": "4195445000000000000000000" },
  "burns": [
    { "tx": "0x...", "logIndex": 5, "caller": "0x...", "usdgIn": "50000000",
      "ethSpent": "20208000000000000", "motifBought": "2700000000000000000000000",
      "motifBurned": "2835000000000000000000000", "block": 55000080, "ts": 1780000800 }
  ]
}
```

`burner` is null when the api has no `MOTIF_BURNER`, which means nothing is
indexed or triggered. That is not the same claim as nothing burned, and a
client should say which one it is showing.

USDG is six decimals, ETH and MOTIF eighteen, all decimal strings. `motifBurned`
can be larger than `motifBought`, because the contract burns everything it
holds: MOTIF sent to it before a call goes with that call's purchase, and both
numbers are carried so the difference shows.

The contract keeps the same totals itself, readable as `burns()`, `usdgSpent()`
and `motifBurned()`, so this route is a convenience and the chain is the record.

## Rate limit

240 requests a minute per address, read from `x-forwarded-for` where present.
Generous enough that no honest integration will ever see it. Over the line:

```
HTTP 429
retry-after: 37

{ "error": "rate limit, 240 requests a minute", "retryAfter": 37 }
```

Open and keyless is not the same as free to hammer: one caller looping the
leaderboard should not make the indexer's own rpc budget somebody else's
problem. `MOTIF_RATE_LIMIT` changes it.

Successful responses carry `cache-control: public, max-age=5`. Errors carry
`no-store`.

## Websocket

```
WS /v1/stream
```

Sends `{"kind":"hello","lastBlock":N}` on connect, then one message per event:

```json
{"kind":"index","id":1,"creator":"0x...","name":"AI Core","symbol":"AICORE","block":55313400}
{"kind":"buy","id":0,"buyer":"0x...","amountIn":"1000000000","block":55313387}
{"kind":"sell","id":0,"seller":"0x...","amountOut":"1486548880","block":55353429}
{"kind":"rebalance","holder":"0x...","id":0,"driftBefore":1970,"block":55313420}
```

Orders and subscriptions are indexed but not streamed. They are a keeper work
list rather than something a public feed should be pushing, and somebody's stop
loss is not a thing to broadcast the moment it is placed.

The server pings every 30 seconds, and a client that has not answered the
previous ping when the next one is due is dropped, so a dead one is gone within
a minute. Any browser or websocket library answers pings on its own, so a client
has nothing to do for this.

That last part is new. It used to ping and never check for an answer, which
dropped nobody: a ping is written into the socket whether or not anyone is at
the other end, so a tab behind a closed laptop lid stayed a subscriber, and was
sent every broadcast, until the operating system gave up on the connection.
Five clients that went silent after the handshake were all still counted
seventy five seconds and two pings later. `scripts/check-connections.mjs` runs
in CI against a one second heartbeat and fails if a silent client survives, or
if a client that does answer is dropped.

A client that stops reading is dropped once a megabyte of events is waiting for
it, rather than having everything after that queued in the one process serving
everybody.

Idle kept-alive http connections are held for 65 seconds. Node's default is
five, which is shorter than the proxy in front holds its own idle connections,
and when the server closes one just as the proxy reuses it, that request comes
back as a 502 that never reached the api at all.

## SDK

```bash
npm i @motif/sdk
```

```ts
import { MotifClient, MotifError } from '@motif/sdk'

const motif = new MotifClient('https://api.motif.fund')

const { indexes } = await motif.leaderboard('return')
const { levels, performance } = await motif.history(indexes[0].id)
const { creators } = await motif.creators()
const { orders } = await motif.orders('0x...')
const { sells } = await motif.sells()

// Keyset paging, one page at a time.
let page = await motif.buys(50)
while (page.next) page = await motif.buys(50, page.next)

const stop = motif.stream((e) => {
  if (e.kind === 'buy') console.log(`motif ${e.id} bought for ${e.amountIn}`)
})
```

Failures throw `MotifError`, which carries `status` and, on a 429, `retryAfter`.

`stream` reconnects on its own with a backoff, because the usual failure is a
laptop lid closing rather than a server going away, and an integration that
silently stops receiving is worse than one that errors.

The SDK also exports `basketRouterAbi`, `rebalancerAbi`, `ordersAbi`, `chain`
and `minOutFrom`. Those ABIs are generated from the compiled artifacts by
`npm run abi` and never written by hand: the hand written version drifted the
moment `createIndex` gained a name and a ticker, and anybody launching through
the SDK would have encoded a call the contract no longer had. They are emitted
as TypeScript rather than JSON, because Node refuses to import a json module
from an ESM package without an import attribute, and because `as const` is what
lets viem infer argument types from the ABI.

It builds transactions and never sends them. Signing stays with your own wallet
library, and the SDK never asks for a key.

## Running it

```bash
cd api
npm install
MOTIF_RPC=https://rpc.mainnet.chain.robinhood.com npm start
```

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Http and websocket port |
| `DATA_DIR` | `./data` | Where the SQLite file lives |
| `MOTIF_RPC` | mainnet rpc | Chain to index |
| `MOTIF_ROUTER` | deployed router | BasketRouter address |
| `MOTIF_REBALANCER` | deployed rebalancer | Rebalancer address |
| `MOTIF_ORDERS` | deployed orders | Orders address |
| `MOTIF_FROM_BLOCK` | head minus 200,000 | Where a fresh index starts. Digits only |
| `MOTIF_KEEPER_KEY` | unset | Without this nothing fires. `0x` and 64 hex digits, unquoted |
| `MOTIF_KEEPER_MS` | `20000` | Keeper sweep interval |
| `MOTIF_KEEPER_GAS_CAP` | `3000000` | Ceiling on one keeper attempt |
| `MOTIF_LEVEL_MS` | `60000` | How often a motif is priced |
| `MOTIF_RATE_LIMIT` | `240` | Requests a minute, per address |

`.env.example` at the repo root carries the same list with the production
warnings attached.

`DATA_DIR` wants a mounted volume. It holds the level history, and that is the
only state that is not reconstructible: everything else can be rebuilt by
rescanning, but on this chain that means paging six million blocks in 5,000
block windows, and no rescan will ever recover a price that was not read at the
time.

## Why the windows are small

The rpc caps a log query at 10,000 results and a wide window blows straight
past it. A truncated page does not error, it just returns less, which would
leave a permanent hole in the index that nothing later would notice. Small
windows are slower and correct.

The indexer also re-scans the last 60 blocks on every pass, because this is an
L2 and a reorg would otherwise leave the cursor sitting past events that never
happened. Re-inserts are idempotent on `(tx, log_index)`, and the websocket only
emits above the previous high water mark, so a re-scan does not replay the
ticker.

## `GET /v1/curves`

Every basket token, newest first. `limit` defaults to 60 and caps at 200.

Empty when `MOTIF_FACTORY` is unset, which is not an error: the tokenised
basket contracts are not deployed anywhere yet, and an api that refused to run
without them could not run against the router that is live. `/v1/status`
reports the factory under `chain.factory`, so an empty list is distinguishable
from an indexer that is quietly broken.

```json
{
  "curves": [
    {
      "curve": "0x1111111111111111111111111111111111111111",
      "indexId": 0,
      "creator": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      "vault": "0x2222222222222222222222222222222222222222",
      "pool": "0x3333333333333333333333333333333333333333",
      "name": "AI Core",
      "symbol": "AICORE",
      "description": "Nvidia and Tesla, sixty forty.",
      "image": "https://motif.fund/v1/images/dd2d4b...",
      "legCount": 2,
      "legs": [
        { "position": 0, "token": "0xd0601c...", "fee": 500, "weight_bps": 6000 },
        { "position": 1, "token": "0x322f09...", "fee": 3000, "weight_bps": 4000 }
      ],
      "creatorFeeBps": 50,
      "threshold": "10000000000",
      "raised": "6300000000",
      "sold": "520000000000000000000000000",
      "supply": "0",
      "graduated": false,
      "progressBps": 6300,
      "block": 1000,
      "tx": "0xfeed...",
      "ts": 1780000000,
      "stateAt": 1780000000
    }
  ]
}
```

`threshold`, `raised`, `sold` and `supply` are decimal **strings**, like every
other amount here, because they are chain amounts and a double loses the low
bits above 2^53. `progressBps` is an integer in basis points so nothing rounds
99.99% up to done.

`stateAt` is when the moving half of the row was last read off the chain.
**Null means never, which is not zero**: a client has to render that as unknown.
The static half comes from the `Launched` log and cannot change; the moving half
is polled every twenty seconds and a curve that has graduated is never polled
again, because nothing about it can move.

The legs are joined in rather than left to the client. A tile is drawn from the
weights, so without them a grid is either N+1 requests deep or a wall of grey
placeholders.

`image` is the url the creator put in the launch's own log, or `null`. **The
chain is the record for it and this api is not.** Nothing here can change the
picture on a basket, re-indexing from block zero reproduces exactly what is
served, and a client that cannot reach this endpoint draws the basket's weights
instead, which is what every motif tile on the site already does.

## `GET /v1/curves/:curve`

One basket token, by its curve address, in the same shape as a row above but
under `curve` rather than `curves`. 404 when it has not been indexed.

The token page reads everything else it needs straight off the chain, so this
exists for the one thing that is only ever in a log: the picture. A page that
cannot reach it still works.

## `GET /v1/curves/:curve/history`

Price and floor over time for one basket token, newest first. `limit` defaults
to 500 and caps at 2,000.

```json
{
  "levels": [
    { "at": 1780086400, "price18": "224000000000000", "floor18": "10920000000000" },
    { "at": 1780082800, "price18": "175989000000000", "floor18": "10880000000000" }
  ]
}
```

Both are USDG per whole token as decimal strings, 1e18.

**`floor18` is null for every reading taken before graduation** and a client has
to draw that as absent rather than as zero. There was no vault holding anything
then, so a floor of zero would be a claim about the backing rather than the
absence of one.

Recorded on the same timer as a motif's level and with the same warning
attached: a price that has already gone cannot be re-read from the chain, so
every sweep that does not happen is a hole nobody can fill later. Before
graduation the price is the curve's own and costs no rpc call, because
`usdgReserve / tokenReserve` is arithmetic on `raised` and `sold`, which the
indexer already polls. After graduation it is the token's own pool, and the
floor is one `backingOf(1e18)` call priced with the leg prices already fetched
for the motifs.

## `POST /v1/images` and `GET /v1/images/:sha256`

Somewhere for a creator's picture to live, so that launching does not begin with
going and finding hosting.

POST the raw bytes, with no wrapper and no form encoding:

```bash
curl -X POST --data-binary @pic.png https://motif.fund/v1/images
```

```json
{
  "hash": "dd2d4b81bbb757b1caec89d962c518eb62e0ce2d03938dfcfe03d233e69346fb",
  "path": "/v1/images/dd2d4b81...",
  "url": "https://motif.fund/v1/images/dd2d4b81...",
  "mime": "image/png",
  "size": 1180
}
```

**Content addressed, which is the whole design.** The id is the sha256 of the
bytes, so the same file is always the same url, a url can be checked against
what it serves, and nothing here can change the picture behind a launch that has
already happened. If this table were lost, no launch would be affected and the
files could be put back at the same urls by whoever still has them.

PNG, JPEG, GIF and WebP, up to 512KB, **read from the bytes rather than from the
content type header**, which is whatever the uploader typed. Anything else is a
415. Twelve uploads a minute per address, separately from the read limit, which
is a different question. `MOTIF_PUBLIC_URL` sets the origin in the returned
`url` when something in front rewrites the host.

The one POST in the api. Everything else is a read, and this one writes bytes
nobody can address except by their own content.

**A rate limit does not bound a disk**, which is the part worth saying out loud.
Twelve uploads a minute of half a megabyte is eight gigabytes a day from one
address, onto the same volume the indexer's database is on, so filling it takes
the whole service down rather than just this endpoint. Two bounds instead: a
ceiling on the total (`MOTIF_IMAGE_STORE_LIMIT`, 512MB by default, answered with
a 507), and a sweep every half hour that deletes anything older than a day that
no launch points at.

The sweep can only ever collect the second case. A picture that has been through
a launch is referenced from a log that cannot be edited, so it is kept for good.
What goes is the file somebody uploaded before closing the tab, and the file
somebody uploaded to fill the disk. A day is long enough that a launch
interrupted by a wallet prompt and finished later still finds its picture.
