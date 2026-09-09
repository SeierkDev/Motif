#!/usr/bin/env bash
# Fill a local anvil fork with motifs to develop against.
#
# Start the fork like this, not with a bare `anvil --fork-url`:
#
#   anvil --fork-url https://rpc.mainnet.chain.robinhood.com #         --fork-block-number $(cast block-number --rpc-url https://rpc.mainnet.chain.robinhood.com) #         --state .anvil-state.json --state-interval 30 #         --compute-units-per-second 60
#
#   forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
#   rm -f api/data/motif.sqlite && (cd api && npm start)
#   scripts/seed-fork.sh
#
# Every one of those flags is there because of a specific failure. The public
# rpc is not an archive node and it rate limits, so an unpinned fork chases the
# head, keeps asking for state that has since been pruned, and dies partway
# through a session. Pinning stops the chasing and throttling the compute units
# keeps it under the rate limit that gets tripped by simply working too fast.
#
# **A fork here has a short shelf life whatever you do, and pinning does not
# change that.** The pinned block gets pruned upstream like any other, and once
# it is gone anvil cannot build a block at all: transactions are accepted into
# the pool, automine says it is on, nothing mines, and the only clue is a
# "metadata is not found" buried in the response to `anvil_mine`. Roughly
# thirteen thousand blocks, well under an hour, was enough to lose a fork this
# way. When mining silently stops, re-fork rather than debugging the app: the
# symptom looks exactly like a hung front end.
#
# `--state` is deliberately not used here. It survives a restart, which sounds
# useful, and then reloads a fork whose upstream state has already been pruned,
# which is the same dead end with extra steps.
set -euo pipefail

RPC=${RPC:-http://127.0.0.1:8545}
ROUTER=${MOTIF_ROUTER:-0x512F7469BcC83089497506b5df64c6E246B39925}

USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA=0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
TSLA=0x322F0929c4625eD5bAd873c95208D54E1c003b2d
AMC=0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B
SLV=0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f
SGOV=0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5
SPY=0x117cc2133c37B721F49dE2A7a74833232B3B4C0C
MSTR=0xec262a75e413fAfD0dF80480274532C79D42da09
NFLX=0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8
LULU=0x4e62068525Ab11FE768e29dfD00ef909B9803016
BABA=0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4
DJT=0x1D11f0496982706C5e14A514D4E79F2e6BdE4516
SPCX=0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa

# The first two anvil accounts. Public, worthless, and the same everywhere.
A_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
A_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
B_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
B_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

# USDG keeps balances in mapping slot 1, found by writing to each slot in turn
# and reading balanceOf back rather than by guessing from an ABI.
fund() {
  cast rpc anvil_setStorageAt "$USDG" "$(cast index address "$1" 1)" "$(cast to-uint256 "$2")" \
    --rpc-url "$RPC" > /dev/null
  cast send "$USDG" "approve(address,uint256)" "$ROUTER" "$2" \
    --private-key "$3" --rpc-url "$RPC" > /dev/null
}

count() { cast call "$ROUTER" 'indexCount()(uint256)' --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1; }

launch() { # key legs feeBps name symbol description spend minOut
  local before after
  before=$(count)
  cast send "$ROUTER" \
    "createAndBuy(address,(address,uint24,uint16)[],uint16,string,string,string,uint256,uint256[])" \
    "$USDG" "$2" "$3" "$4" "$5" "$6" "$7" "$8" \
    --private-key "$1" --rpc-url "$RPC" > /dev/null
  after=$(count)

  # Checked rather than assumed, because a send that changes nothing still
  # succeeds. Pointed at an address with no code, every cast send below returns
  # 0 and this printed "launched" fourteen times over an empty chain, which is
  # a very convincing way to waste an afternoon. The count is the only thing
  # that knows whether a basket exists.
  if [ -z "$after" ] || [ "$before" = "$after" ]; then
    echo "  FAILED to launch $5: indexCount stayed at ${before:-unreadable}" >&2
    echo "  is $ROUTER really a BasketRouter on $RPC?" >&2
    exit 1
  fi
  echo "  launched $5"
}

if [ "$(cast code "$ROUTER" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
  echo "no contract at $ROUTER on $RPC." >&2
  echo "Deploy first: PRIVATE_KEY=<key> forge script script/Deploy.s.sol:Deploy \\" >&2
  echo "  --rpc-url $RPC --broadcast --private-key <key>" >&2
  echo "then re-run with MOTIF_ROUTER set to the BasketRouter it prints." >&2
  exit 1
fi

fund "$A_ADDR" 60000000000 "$A_KEY"
fund "$B_ADDR" 60000000000 "$B_KEY"

launch "$A_KEY" "[($NVDA,500,6000),($TSLA,3000,4000)]" 50 \
  "AI Core" "AICORE" "NVDA and TSLA, sixty forty. The two names everyone actually wants." \
  3000000000 "[0,0]"

launch "$A_KEY" "[($SPY,500,10000)]" 10 \
  "Just the Index" "JUSTSPY" "The S&P 500 and nothing else, for people who want the boring answer." \
  2500000000 "[0]"

launch "$B_KEY" "[($NVDA,500,4000),($MSTR,10000,3000),($TSLA,3000,3000)]" 100 \
  "Leverage Everything" "LEVER" "The three most violent tickers on this chain in one basket." \
  1800000000 "[0,0,0]"

launch "$B_KEY" "[($SGOV,3000,6000),($SLV,3000,4000)]" 25 \
  "Sleep At Night" "SLEEP" "Short treasuries and silver. Built to be dull on purpose." \
  4000000000 "[0,0]"

launch "$A_KEY" "[($NVDA,500,2500),($TSLA,3000,2500),($NFLX,3000,2500),($SPY,500,2500)]" 50 \
  "Four Corners" "CORNERS" "Equal weight across a chip maker, a car company, a streamer and the market." \
  1200000000 "[0,0,0,0]"

launch "$B_KEY" "[($AMC,3000,7000),($MSTR,10000,3000)]" 100 \
  "Diamond Hands" "DIAMOND" "AMC and MicroStrategy. You already know whether this one is for you." \
  700000000 "[0,0]"

# Eight more, so a grid has enough in it to look like a place people use and the
# filters have something to sort. Leg counts one to five, every fee tier, and
# every ticker with a pool gets used at least once: a page only ever tested
# against two leg baskets of the same three names is a page whose other rows
# nobody has seen.

launch "$A_KEY" "[($SPCX,500,6000),($NVDA,500,4000)]" 50 \
  "Orbital Access" "ORBIT" "SpaceX with a chip maker behind it. Two ways to own the same buildout." \
  2200000000 "[0,0]"

launch "$A_KEY" "[($LULU,3000,6000),($NFLX,3000,4000)]" 25 \
  "Stretch Goals" "STRETCH" "Leggings and streaming. What people actually spend a Sunday on." \
  900000000 "[0,0]"

launch "$A_KEY" "[($NVDA,500,8000),($SGOV,3000,2000)]" 50 \
  "Chip Tax" "CHIPTAX" "Mostly NVDA, with a fifth in short treasuries so it is not a single name bet." \
  3400000000 "[0,0]"

launch "$A_KEY" "[($NVDA,500,2000),($TSLA,3000,2000),($SPY,500,2000),($SLV,3000,2000),($AMC,3000,2000)]" 75 \
  "Everything Bagel" "BAGEL" "Five names, twenty percent each, no opinion whatsoever." \
  1500000000 "[0,0,0,0,0]"

launch "$B_KEY" "[($BABA,3000,7000),($SPY,500,3000)]" 50 \
  "East Bound" "EAST" "Alibaba with an index behind it, for the version of this trade that can be slept on." \
  1100000000 "[0,0]"

launch "$B_KEY" "[($DJT,10000,5000),($AMC,3000,3000),($MSTR,10000,2000)]" 100 \
  "Loud Money" "LOUD" "The three tickers that generate the most argument per dollar." \
  800000000 "[0,0,0]"

launch "$B_KEY" "[($SLV,3000,5000),($SGOV,3000,5000)]" 25 \
  "Metal and Bills" "METAL" "Silver and short treasuries, half each. The oldest two ideas there are." \
  2600000000 "[0,0]"

launch "$B_KEY" "[($NFLX,3000,5000),($TSLA,3000,2500),($BABA,3000,2500)]" 50 \
  "Screen Time" "SCREEN" "A streamer, a car company that trades like a meme, and Alibaba." \
  1300000000 "[0,0,0]"

# A second buyer on one of them, so holder counts are not all one.
cast send "$ROUTER" "buy(uint256,uint256,uint256[])" 0 900000000 "[0,0]" \
  --private-key "$B_KEY" --rpc-url "$RPC" > /dev/null
echo "  second buyer on #0"

echo "motifs: $(cast call "$ROUTER" 'indexCount()(uint256)' --rpc-url "$RPC")"

# ---------------------------------------------------------------- basket tokens
#
# Optional, because the factory is optional. Nothing tokenised has to exist for
# the motifs above to work, and the site is built to say so rather than to offer
# a button that reverts, so this skips quietly when MOTIF_FACTORY is unset:
#
#   MOTIF_ROUTER=<router> PRIVATE_KEY=<key> forge script script/DeployFactory.s.sol \
#     --rpc-url $RPC --broadcast --private-key <key>
#   MOTIF_FACTORY=<factory> scripts/seed-fork.sh

FACTORY_ADDR=${MOTIF_FACTORY:-}

if [ -z "$FACTORY_ADDR" ]; then
  echo "no MOTIF_FACTORY set, skipping basket tokens (motifs above are unaffected)"
else
  if [ "$(cast code "$FACTORY_ADDR" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
    echo "no contract at MOTIF_FACTORY=$FACTORY_ADDR on $RPC." >&2
    exit 1
  fi

  curves() { cast call "$FACTORY_ADDR" 'count()(uint256)' --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1; }

  # The factory pulls the opening buy from the launcher, so it needs its own
  # allowance. The router's approval above does not cover it.
  approve_factory() {
    cast rpc anvil_setStorageAt "$USDG" "$(cast index address "$1" 1)" "$(cast to-uint256 90000000000)" \
      --rpc-url "$RPC" > /dev/null
    cast send "$USDG" "approve(address,uint256)" "$FACTORY_ADDR" 90000000000 \
      --private-key "$2" --rpc-url "$RPC" > /dev/null
  }
  approve_factory "$A_ADDR" "$A_KEY"
  approve_factory "$B_ADDR" "$B_KEY"

  token() { # key legs feeBps threshold name symbol description spend
    local before after
    before=$(curves)
    cast send "$FACTORY_ADDR" \
      "launchAndBuy((address,uint24,uint16)[],uint16,uint256,string,string,string,string,uint256,uint256)" \
      "$2" "$3" "$4" "$5" "$6" "$7" "" "$8" 0 \
      --private-key "$1" --rpc-url "$RPC" > /dev/null
    after=$(curves)
    if [ -z "$after" ] || [ "$before" = "$after" ]; then
      echo "  FAILED to launch token $6: count stayed at ${before:-unreadable}" >&2
      exit 1
    fi
    echo "  token $6"
  }

  # Six, and the last one deliberately buys past its own threshold so one of
  # them has graduated to a real pool while the rest are still raising. Both
  # states have to be on the page at once: a grid only ever seen full of raising
  # curves is a grid whose graduated card nobody has looked at.
  token "$A_KEY" "[($AMC,3000,6000),($DJT,10000,4000)]" 100 10000000000 \
    "Paper Hands" "PAPER" "AMC and Trump Media. Named honestly." 1200000000

  token "$A_KEY" "[($SGOV,3000,7000),($SPY,500,3000)]" 25 10000000000 \
    "Quiet Compounding" "QUIET" "Short treasuries and the index. Nothing happens here on purpose." 3500000000

  token "$A_KEY" "[($NVDA,500,5000),($MSTR,10000,5000)]" 50 10000000000 \
    "Two Chips" "TWOCHIPS" "Half a chip maker, half a company that buys bitcoin." 800000000

  token "$B_KEY" "[($NFLX,3000,5000),($LULU,3000,3000),($TSLA,3000,2000)]" 50 10000000000 \
    "Long Weekend" "WEEKEND" "Streaming, leggings and a car. A Saturday in three tickers." 2600000000

  token "$B_KEY" "[($SGOV,3000,5000),($DJT,10000,5000)]" 75 10000000000 \
    "Bar Bell" "BARBELL" "The safest thing on the chain next to the loudest. Half each." 400000000

  # The curve sells a fixed 750M supply across the whole raise, so a buy worth
  # more than the threshold asks for tokens that do not exist and reverts with
  # SupplyExhausted. Filling a raise means landing on the threshold, not passing
  # it, which is why this is two buys of seven and three rather than one of ten.
  token "$B_KEY" "[($TSLA,3000,4000),($SPCX,500,3000),($MSTR,10000,3000)]" 100 10000000000 \
    "Full Send" "FULLSEND" "Tesla, SpaceX and MicroStrategy. Fills its raise and opens a pool." 7000000000

  FULLSEND=$(cast call "$FACTORY_ADDR" 'curves(uint256)(address)' \
    "$(( $(curves) - 1 ))" --rpc-url "$RPC" | cut -d' ' -f1)

  cast send "$USDG" "approve(address,uint256)" "$FULLSEND" 3000000000 \
    --private-key "$A_KEY" --rpc-url "$RPC" > /dev/null
  cast send "$FULLSEND" "buy(uint256,uint256)" 3000000000 0 \
    --private-key "$A_KEY" --rpc-url "$RPC" > /dev/null
  echo "  second buyer on FULLSEND, raise filled"

  # Graduating is what turns a curve into a real Uniswap pool, and it is the
  # state the token page renders differently. Zero minimums here because this is
  # a fork with nobody racing it; on a live chain that argument is the only
  # thing bounding a five leg market order.
  cast send "$FULLSEND" "graduate(uint256[])" "[0,0,0]" \
    --private-key "$A_KEY" --rpc-url "$RPC" > /dev/null
  echo "  FULLSEND graduated: $(cast call "$FULLSEND" 'graduated()(bool)' --rpc-url "$RPC")"

  echo "basket tokens: $(curves)"
fi

