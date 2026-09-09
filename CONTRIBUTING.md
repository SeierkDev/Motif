# Contributing

## The one rule

**Measure it against the chain rather than asserting it.**

Nearly every real bug in this repository was found by running something and
reading the number that came back, and none of them were found by reading the
code harder. The router was written against the wrong venue because a balance
in Uniswap V4 was taken as proof the pair was there. The size cap rejected every
sell order because a 6 decimal figure was compared against an 18 decimal one.
Seven of the twelve token addresses had invalid checksums, which broke the whole
portfolio page for everybody, and it survived for weeks because the five that
happened to be correct were the five every test used.

A mock would have passed in all three cases. So:

- tests fork mainnet and use the real pools and the real tokens
- claims about depth, price impact or profitability come with the number and the
  test that produced it
- when something is unknown, it says so rather than defaulting to zero, because
  "flat" and "we have not been watching long enough" are different answers

## Running it

Setup is in the [README](README.md#running-it). No API key and no funded wallet:

```bash
forge test                       # 85 fork tests, no key needed
cd api && npx tsx src/check-addresses.ts
node scripts/api-smoke.mjs       # with the api running
```

## Before you open a pull request

- `forge test` passes. It takes about four minutes, most of it forking.
- `npx tsc --noEmit` in `api/` and in `web/`.
- `node scripts/gen-abi.mjs` produces no diff. The ABIs in the SDK and the site
  are generated from the compiled artifacts and a stale one is a user's
  transaction reverting rather than a build failing.
- `npx tsx src/check-addresses.ts` in `api/`.
- If you touched the front end, measure it at 390px wide and check the page does
  not scroll sideways. Measure it rather than eyeballing a screenshot: a
  headless browser will happily report a 980px layout while showing you
  something that looks fine.

CI runs all of it, including calling every route the api advertises against a
fixture database.

## House style

Comments explain **why**, not what. If a line looks strange, the comment says
what went wrong without it. Several of them name a specific bug on purpose, so
nobody removes the guard and reintroduces it.

Copy is plain: say what the thing is and what you do with it. No slogans. When
something can lose money or cannot be undone, say so in the interface rather
than in the docs.

## What would be genuinely useful

- **More tickers.** The twelve here are the ones with a real USDG pool, found by
  walking the V3 factory. Anything with a live pool can be added.
- **Another keeper.** Nothing pays for gas today, and the design is
  permissionless precisely so it does not depend on one machine.
- **Reproducing a measurement and disagreeing with it.** The sandwich numbers in
  `test/Sandwich.t.sol` are the ones that decided against a private submission
  path. If they are wrong, that changes the design.
