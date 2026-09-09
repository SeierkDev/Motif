# Basket router, design decisions

The four questions that had to be answered before any Solidity. Written after
Phase 0 established that the venue is a Uniswap V4 PoolManager at
`0x8366a39cc670b4001a1121b8f6a443a643e40951`, which settles more of this than
expected.

## Why V4 changes the shape

V4 is a singleton with flash accounting. A basket buy opens one `unlock`, does
every swap inside the callback against net deltas, and settles once at the end.
Tokens move twice rather than twice per leg.

That means atomicity is not something to engineer, it is the default. The
router is an `IUnlockCallback` implementation and nothing else. It never holds a
balance between transactions, which is the non custodial property stated as a
structural fact rather than a promise.

## 1. Is an index onchain or a signed offchain object?

**Onchain, immutable once created.**

An offchain signed object is cheaper to create and would have been the lazy
answer. It is the wrong one. The pitch is that anyone can launch an index and
other people can buy it. A thing that exists only as a signature is not an
index, it is a trade instruction: it cannot be listed, cannot be linked to, and
cannot carry an enforceable creator fee.

Storage per index: creator, an array of `(token, weightBps)` summing to 10,000,
a creator fee in bps, and a created timestamp. Creation gas on a subsidised L2
is negligible next to what it buys.

**Immutable matters more than it looks.** If weights can be edited after
publication, a creator can wait for buyers to arrive and then repoint the index
at something worthless. A new set of weights is a new index with a new id. The
old one keeps working and keeps its record.

## 2. How is slippage bounded across five legs at once?

**Per leg minimums computed client side from a live quote, enforced inside the
callback, plus a check that no input is left unspent.**

The tempting design is one global bound: "spend 1,000 USDG, receive at least
990 USDG of value". It cannot be done safely here. Valuing five different
tokens in one currency inside the transaction requires the oracle, and Phase 0
measured an NVDA feed **120 minutes stale while the US market was open**,
because feeds update on deviation rather than a heartbeat. A global bound would
silently price a basket against a two hour old number.

Per leg minimums need no oracle at all. The client quotes each leg, applies the
user's slippage tolerance, and passes an array. The contract enforces it. The
oracle is then only ever used for display and for drift detection in Phase 2,
never for settlement.

## 3. If leg three of five fails, revert or deliver a partial basket?

**Revert the whole transaction.**

A partial basket is not the product the buyer asked for. They would hold three
of five positions at wrong weights, with no automatic route back, and the
keeper in Phase 2 would have no defined target to rebalance toward.

Because everything happens inside a single `unlock`, a revert is clean and
costs only gas. Strict all or nothing is also a safety property: there is no
partial state to reason about, which is the kind of simplicity that keeps an
unaudited contract survivable.

## 4. How does a creator take a fee without ever holding funds?

**Skimmed from the input currency and transferred to the creator inside the
same transaction, before the swaps.**

The buyer sends USDG. The router deducts the creator fee and the protocol fee,
forwards both straight to their destinations, and swaps the remainder. Nothing
accrues in the contract, so there is no fee balance to withdraw, no admin
function to drain, and no pot that a bug can empty.

Creator fee is capped in the contract, 100 bps, so a published index cannot be
predatory, and both fees are shown on the buy screen before signing.

## 5. How does anyone get out again?

Shipped first without an answer, which was wrong. A buyer could enter a ten leg
basket in one transaction and then had to unwind it one leg at a time somewhere
else. One click in and no click out is not a product, and it is the first thing
anybody hostile would have pointed at.

`sell(id, amounts, minOut)` is the mirror of the buy, with three decisions in it.

**Amounts, not a percentage.** The obvious signature is "sell 25% of this
basket" and it is wrong. Leg tokens are ordinary ERC20s in the seller's own
wallet, so somebody who bought three baskets containing NVDA holds one NVDA
balance, not three. A contract reading `balanceOf` and selling a quarter of it
would be selling a quarter of everything they own of that ticker. Only the
caller can know which tokens they mean, so the caller says.

**No fee on the way out.** The creator fee and the protocol fee are charged on
the buy and nowhere else. An exit fee means a creator earns when people leave,
which is the wrong incentive to write into a contract that can never be edited,
and it turns "you can always leave" into a claim with a footnote.

**The router never holds the tokens.** The buy path pulls the quote asset in
first because the fees come out of it. A sale has no fees, so there is nothing
to take out, and the legs go straight from the seller's wallet to the pool
inside the swap callback. That made the callback pay on behalf of somebody else
for the first time, which needed a new bound: the callback now refuses to pay
more than the leg it was handed. Anyone can publish an index pointing a leg at
any token, so anyone can make this router call a pool they wrote themselves, and
without that bound such a pool could have asked for the seller's whole
allowance rather than the amount its swap was for.

## What this makes the contract

One contract implementing `IUnlockCallback`. It holds no balances, has no admin
withdrawal path, and its only privileged surface is the fee cap constant. A
buyer approves the input token, calls `buy(indexId, amountIn, minOut[])`, and
either receives every leg in their own wallet or the transaction reverts.

## Open, for Phase 1 implementation

Whether to route approvals through Permit2, which the V4 periphery expects, or
take a plain ERC-20 approval. Permit2 is better UX and one more dependency to
trust. Decide when writing the contract, not before.
