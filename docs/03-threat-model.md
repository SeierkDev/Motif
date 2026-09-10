# Threat model

Written at the Phase 6 gate, before mainnet. These contracts are **not audited**
and there is no audit budget. This document exists so that what is and is not
protected is written down rather than assumed, and so anyone reviewing has a
list to argue with.

## What an attacker cannot reach

Nothing is pooled and nothing is escrowed. All three contracts hold a zero
balance of every token between transactions, asserted by test in each suite.
There is no withdrawal function anywhere, because there is nothing to withdraw.

This is the single most important property here. A protocol holding a treasury
loses that treasury to one bug. Motif has no treasury to lose, so the worst case
is bounded by what one transaction can pull from one allowance.

## The real exposure: standing allowances

`Rebalancer` and `Orders` work by allowance. A user who approves
`type(uint256).max` is trusting the contract with everything they hold of that
token, for as long as the approval stands.

**Mitigations, in order of how much they actually help:**

1. **Approve only what you intend to trade.** The site should ask for a bounded
   approval, not an unlimited one. This is worth more than everything below.
2. `maxNotional` bounds what a single call can move, set to 25,000 USDG for the
   review window.
3. Revoking the allowance kills every order and subscription instantly, with no
   permission needed from anyone.
4. The guardian can pause, which stops keepers touching allowances at all while
   people revoke at their own pace.

## Findings from the Phase 6 review

**Unbounded slippage in `Rebalancer`. Critical, fixed.** `maxSlippageBps` was
recorded at subscribe time and then never read. Combined with a permissionless
keeper and a wide open `sqrtPriceLimitX96`, anyone could sandwich a rebalance
and take most of the position. Every swap now carries a floor derived from the
Chainlink price and the holder's own tolerance, and the tolerance itself is
capped at 10%. Regression test:
`test_rebalancer_enforces_the_holders_slippage`.

**A TWAP with no interval. Medium, fixed.** `place` did not require
`interval > 0`, so a TWAP could be drained in a single block by one keeper,
which removes the only thing a TWAP is for. Now rejected at placement.

**Handing the guardian to nobody while paused. Medium, fixed.**
`transferGuardian(address(0))` would have left the contract paused with no
address able to unpause it, permanently. It now reverts and points at
`renounceGuardian`, which unpauses on its way out.

## Findings from the full scan, 5 Sep 2026

**The size cap rejected every sell order. High, fixed.** `maxNotional` is a USDG
figure with 6 decimals and a sell order is sized in the stock token with 18, so
one NVDA read as 1e18 against a cap of 2.5e10. Every stop loss, limit sell and
trailing stop was refused the moment a cap was set, whatever the position was
worth. The earlier suites missed it because they build Orders with no cap, and
the one cap test used a buy, which genuinely is denominated in USDG. The sell
side is now valued at the pool price before the cap is applied.

**The rebalancer ignored its own cap. Medium, fixed.** It was constructed with a
`maxNotional` and never read it, so the largest positions sat outside the limit
written for them. Now checked against the position value.

**The SDK ABI had drifted. Medium, fixed.** It was maintained by hand and still
described a `createIndex` without a name or ticker, so anyone launching through
the SDK would have encoded a call the contract no longer has. It is now
generated from the compiled artifacts by `npm run abi`.

**No reorg handling. Low, mitigated.** The indexer advanced its cursor and never
looked back, so a block reorganised out left a permanent hole. It now re-scans
60 blocks of tip on every pass, which is free because the writes are idempotent,
with the live feed gated so the ticker does not replay. It still does not remove
a log that vanished, which is the honest limit.

## New surface from the sell path

Selling made the swap callback pay a pool **on behalf of the caller** rather
than out of tokens the router was already holding, which is a genuinely new
exposure and is worth setting out plainly.

**What an attacker controls.** Anyone can publish an index, and a leg may point
at any token with a pool at the real factory. So anyone can make this router
call a pool they wrote themselves, with a callback they control, during a
transaction some other user started.

**What that pool cannot do.** It cannot be reached outside a swap the router
started, because the guard is zero at every other moment. It cannot impersonate
a pool for a different pair, because the address is checked against the factory
for the pair encoded in the callback data. It cannot choose the payer, because
the payer travels in data the router encoded and the pool hands back untouched.
And it cannot take more than the leg it was handed: the guard doubles as the
maximum, so a pool asking for more than the swap it was given reverts with
`PoolWantsTooMuch`.

Without that last bound, a hostile leg token's pool could have asked for the
seller's entire allowance for that token rather than the amount being sold. That
is the difference between "the user approved 5 NVDA for this sale" and "the user
once approved unlimited NVDA". Tested by writing the guard directly and calling
the real pool, since it is only ever nonzero mid swap.

**The seller still approves per ticker.** A five leg exit is five ERC20
approvals the first time. That is deliberate: the alternative is a single
blanket permission to a contract that can now move tokens out of a wallet, and
the size of that permission is exactly the thing a user should be choosing.

## Accepted risks, stated rather than solved

**Indexes may name any input token.** `createIndex` accepts an arbitrary
`input`, so somebody can publish an index whose input token is malicious. It
cannot reach another user's funds, because the router holds nothing and the
reentrancy guard blocks a second `buy`. The loss is bounded to whoever chose to
buy that index. The site only lists USDG indexes, but the contract is open and
someone can always call it directly. **If you buy an index, read its legs.**

**Stops are stop limits, not stop markets.** The minimum output is anchored to
the price the owner named, so a gap wider than their tolerance does not fill at
any price. This is deliberate: anchoring to spot would let whoever pushed the
pool to trip the stop also fill it cheaply. The cost is that a violent gap
leaves the stop unfilled. Tested as
`test_a_gap_wider_than_the_tolerance_does_not_fill`.

**Pool prices can be pushed.** Orders trigger on the pool, because the oracle is
dead at weekends and an order that cannot fire on a Sunday defeats the product.
A well capitalised actor can therefore trigger somebody's stop. They cannot
profit from filling it, because the floor is anchored to the owner's number, but
they can force an exit. The USDG/NVDA 500 pool absorbs 2,700 NVDA for about
0.68%, so this is expensive rather than impossible.

**Keeper transactions are public, and that turns out not to matter. Measured.**
A `rebalance` goes through the public mempool, so anybody can see it coming and
trade around it. Whether that is possible was never in question. Whether it is
worth doing is a number, and `test/Sandwich.t.sol` measures it against the real
pools on a mainnet fork rather than arguing about it.

The attack on a rebalance's sell leg is the ordinary one: sell first to push the
price down, let the victim sell into the hole, buy back cheaper. Two things bound
it. The victim's floor is anchored to the oracle, so pushing too far makes their
transaction revert and the attacker collects nothing. And the attacker pays the
pool fee twice, on their own size rather than on the victim's.

The second bound is the one that decides it:

| | |
| --- | --- |
| NVDA to push the USDG pool 1% | 3,206, about $737,500 |
| pool fees on that round trip | $737 |
| most a 1% push takes from a $9,200 rebalance | $13 |

Across three position sizes and all four slippage settings a holder can choose,
every sandwich in the sweep **lost the attacker money**. The best outcome
available anywhere in the grid was **minus 91 cents**, and it got worse with
size, because the attacker's cost scales with their own notional while the prize
scales with the victim's. There is no size at which it turns positive.

It is not thin pools elsewhere either. A $5,000 round trip costs 19 bps in the
500 tier, 69 in the 3000 tier and 208 in the 10000 tier, of which only about 9
bps is price impact and the rest is the fee. Higher fee tiers are more protected,
not less.

**So: no private submission path, and the bound is documented instead.** Two
things would change that answer, and both are watched. If pool depth collapsed,
the impact per dollar would rise and the arithmetic could invert; the assertion
in that test fails if a rebalance ever becomes worth attacking, so this does not
rot quietly. And an attacker who is themselves the liquidity provider earns the
fee back rather than paying it, which is not modelled here and is the one
version of this worth revisiting.

**Keepers have no reward.** Nothing pays a keeper for gas. In practice we run
one, and anyone may run another. This is a liveness assumption, not a safety
one: if every keeper stops, orders simply do not fire and no funds are at risk.
It is an open problem for Phase 8.

**The feed registrar is a trusted role.** `registerFeed` is owner only and
add-only: a feed can be set once for a token and never repointed, so a live
subscription cannot have its prices swapped underneath it. A wrong feed
registered the first time is still a wrong feed.

## The burner

`MotifBurner` spends the protocol's 0.10% on MOTIF and burns it. It sits
outside the custody claim entirely: it never touches a buyer's funds, a
creator's fee, a motif or a vault, only USDG that the fee wallet has chosen to
let it pull.

**What it can move.** USDG from exactly one address, the router's
`protocolFeeTo` as read off the router at deploy time, up to that wallet's
allowance, at most $50 a call, and only inside a call that also buys MOTIF and
burns it. No owner, no settings, no withdrawal, and any ETH that did not come
from unwrapping WETH is refused.

**Who can call it.** Anyone, with any floor, zero included. That is only safe if
a sandwich around it loses money, so it is measured rather than argued.
`test_a_sandwich_around_the_largest_burn_loses_money` buys on the real curve,
lets a $50 burn with no floor land, and sells back, at five sizes from 0.003 to
0.1 ETH. **Every one lost.** The best outcome anywhere in the sweep was
-0.000026 ETH, and the loss grew with size. The reason is the fee: Pons charges
1% on each of the attacker's two trades while the prize is bounded by the burn,
so a sandwich only pays once the burn is larger than the fee times the curve's
quote reserve. That was about $93 at 3.76 ETH of reserve. The cap is $50, and
the reserve only grows until graduation.

**The fee wallet is trusted, and visibly so.** It is an ordinary wallet. It can
revoke the approval, or move the fees before they are pulled. Paying the
burner directly would need a new router, since `protocolFeeTo` is immutable.
What makes this acceptable is that the allowance and the balance are both
public, so anybody can see whether the fees are being left for the burner.

**Anything else in that wallet is burnable.** The approval is on USDG, not on
"fees". USDG that lands in the fee wallet for any other reason can be pulled
and burned by anybody, at up to $50 a call. Keep nothing else there.

**Pons is trusted for the purchase.** The curve is Pons's contract. The burner
sends it the ETH and takes MOTIF back in the same call, with the floor checked
by the curve itself. A curve that kept the ETH would cost at most one call's
$50, and the curve address is fixed at deployment.

**Graduation retires it.** Once MOTIF leaves its curve, `buy` stops working and
every burn reverts. `test_at_the_graduation_line_a_burn_is_all_or_nothing`
drives the real curve with 53 buys until it stops selling and shows the burn
reverting with the fees exactly where they were. Because the pull and the spend
are one transaction, nothing is ever stranded in the contract. A successor with
the post graduation route has to be deployed at that point, and the fee wallet
moves its approval to it.

## The guardian

One address. It can pause, unpause, set `maxNotional`, hand over to another
address, or renounce permanently.

It **cannot** move tokens, take a fee, change an index, change a price feed, or
take a position. There is nothing held for it to reach.

Pausing costs a user nothing, which is what makes an unaudited kill switch
acceptable here: their tokens never left their own wallet, and they can revoke
without the guardian's help. Tested as
`test_pausing_costs_the_holder_nothing`.

`renounceGuardian` is one way and unpauses on the way out. It is meant to be
used once the contracts have earned it.

## Deploy time parameters for the review window

| Parameter | Value | Why |
| --- | --- | --- |
| `maxNotional` | 25,000 USDG | Bounds what one call can pull from one allowance |
| `MAX_CREATOR_FEE_BPS` | 100 | A published index cannot be predatory |
| Rebalancer slippage cap | 1,000 bps | A subscription that accepts any price is an invitation |
| Orders slippage cap | 5,000 bps | Wider, because the owner names the anchor price themselves |

## What would change this document

An audit. Until then the honest summary is: the contracts are small, they hold
nothing, they have no admin withdrawal path, and one critical bug was already
found by looking properly. There will be others.
