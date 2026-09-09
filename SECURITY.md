# Reporting a vulnerability

**These contracts are unaudited.** They are deployed and they hold standing
allowances. If you have found something that lets you take money that is not
yours, please report it privately rather than opening an issue.

Use GitHub's private vulnerability reporting on this repository: **Security →
Report a vulnerability**. That opens a thread only the maintainers can see. If
that is not available to you, a direct message to
[@SeierkDev](https://x.com/SeierkDev) asking for a channel is fine, and please
do not put details in a public message.

Expect a first reply within 72 hours.

## What is in scope

Anything that moves value, or that stops value moving when it should:

- taking tokens or a quote asset from somebody who did not authorise it
- getting more out of a swap than the per leg minimum should allow
- making a keeper execute an operation the holder did not ask for
- getting past `maxNotional`, the pause, or a subscription's slippage cap
- a published index that can be made to behave differently after people buy it
- the indexer or the api being made to report something the chain does not say

## What is already known, and not a finding

These are documented in [docs/03-threat-model.md](docs/03-threat-model.md) with
the reasoning and, where it exists, the measurement:

- **An index may name any leg token or quote asset.** Anyone can publish one
  pointing at something malicious. The loss is bounded to whoever chose to buy
  that index, because the router holds nothing between transactions.
- **Stops are stop limits, not stop markets.** A gap wider than the owner's
  tolerance does not fill at any price. That is deliberate.
- **Pool prices can be pushed to trigger somebody's stop.** They cannot be
  filled profitably by whoever pushed them, because the floor is anchored to
  the owner's own number.
- **Keeper transactions are public.** Measured rather than argued: every
  sandwich in the sweep lost the attacker money, and the best outcome anywhere
  in the grid was minus 91 cents. See `test/Sandwich.t.sol`. If you can show a
  case where it pays, that is very much a finding.
- **Keepers have no reward.** A liveness assumption, not a safety one.
- **There is a guardian.** It can pause and it can cap what one call moves. It
  cannot move anyone's tokens, and there is nothing held for it to reach.

## What helps

A failing test says more than a paragraph. The suite runs against a mainnet
fork with no key, so a proof of concept can be a real one:

```bash
forge test --match-test your_test -vvv
```

If it needs a specific block, pin it with `--fork-block-number` and say which,
because this chain's public rpc prunes state within the hour and a fork that
worked yesterday will not reproduce today.
