#!/usr/bin/env bash
# Publish the starting motifs on a real chain, for gas and nothing else.
#
# `seed-fork.sh` is for a local anvil and cannot be used here: it funds its
# wallets with `anvil_setStorageAt` and buys into every basket it launches, and
# neither of those exists on a chain nobody controls. This publishes the same
# baskets with plain `createIndex`, which moves no money at all.
#
# **A motif costs nothing to publish beyond gas.** `createIndex` records the
# holdings and the weights and emits an event. It does not buy anything, hold
# anything or require the publisher to own a single unit of the legs. So filling
# an empty Explore page does not need a treasury, only a funded deployer.
#
#   MOTIF_ROUTER=0x... PRIVATE_KEY=0x... RPC=https://rpc.mainnet.chain.robinhood.com \
#     scripts/publish-motifs.sh
#
# Every leg is checked against the pool it names before anything is sent,
# because `createIndex` reverts with `NoPoolForLeg` and a revert halfway through
# leaves the page half full with no way to tell which ones landed.
set -uo pipefail

RPC=${RPC:-https://rpc.mainnet.chain.robinhood.com}
ROUTER=${MOTIF_ROUTER:-}
KEY=${PRIVATE_KEY:-}

USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
UNI_FACTORY=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA

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

if [ -z "$ROUTER" ] || [ -z "$KEY" ]; then
  echo "usage: MOTIF_ROUTER=0x... PRIVATE_KEY=0x... [RPC=...] scripts/publish-motifs.sh" >&2
  exit 1
fi

if [ "$(cast code "$ROUTER" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
  echo "no contract at MOTIF_ROUTER=$ROUTER on $RPC" >&2
  exit 1
fi

SENDER=$(cast wallet address --private-key "$KEY" 2>/dev/null)
if [ -z "$SENDER" ]; then
  echo "PRIVATE_KEY is not a usable key" >&2
  exit 1
fi

BAL=$(cast balance "$SENDER" --rpc-url "$RPC" 2>/dev/null)
echo "publishing as $SENDER"
echo "gas balance   $BAL wei"
if [ "$BAL" = "0" ]; then
  echo "that wallet has no gas on this chain, so nothing can be published." >&2
  exit 1
fi

count() { cast call "$ROUTER" 'indexCount()(uint256)' --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1; }

# Read before sending. A leg naming a pool that does not exist reverts the whole
# createIndex, and finding that out one basket at a time on a live chain costs a
# failed transaction each time.
check_pool() {
  local pool
  pool=$(cast call "$UNI_FACTORY" 'getPool(address,address,uint24)(address)' \
    "$USDG" "$1" "$2" --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1)
  case "$pool" in
    0x0000000000000000000000000000000000000000|'') return 1 ;;
    *) return 0 ;;
  esac
}

publish() { # legs feeBps name symbol description
  local before after
  before=$(count)
  cast send "$ROUTER" \
    "createIndex(address,(address,uint24,uint16)[],uint16,string,string,string)" \
    "$USDG" "$1" "$2" "$3" "$4" "$5" \
    --private-key "$KEY" --rpc-url "$RPC" > /dev/null
  after=$(count)
  if [ -z "$after" ] || [ "$before" = "$after" ]; then
    echo "  FAILED to publish $4: indexCount stayed at ${before:-unreadable}" >&2
    exit 1
  fi
  echo "  published $4 (#$before)"
}

echo "motifs before: $(count)"

# Checked first, all of them, so a missing pool stops this before it has spent
# anything rather than after it has spent some.
echo "checking pools..."
for leg in "$NVDA 500" "$TSLA 3000" "$AMC 3000" "$SLV 3000" "$SGOV 3000" "$SPY 500" \
           "$MSTR 10000" "$NFLX 3000" "$LULU 3000" "$BABA 3000" "$DJT 10000" "$SPCX 500"; do
  # shellcheck disable=SC2086
  if ! check_pool $leg; then
    echo "  no pool for $leg, refusing to publish anything" >&2
    exit 1
  fi
done
echo "  all twelve legs have a pool"

publish "[($NVDA,500,6000),($TSLA,3000,4000)]" 50 \
  "AI Core" "AICORE" "NVDA and TSLA, sixty forty. The two names everyone actually wants."

publish "[($SPY,500,10000)]" 10 \
  "Just the Index" "JUSTSPY" "The S&P 500 and nothing else, for people who want the boring answer."

publish "[($NVDA,500,4000),($MSTR,10000,3000),($TSLA,3000,3000)]" 100 \
  "Leverage Everything" "LEVER" "The three most violent tickers on this chain in one basket."

publish "[($SGOV,3000,6000),($SLV,3000,4000)]" 25 \
  "Sleep At Night" "SLEEP" "Short treasuries and silver. Built to be dull on purpose."

publish "[($NVDA,500,2500),($TSLA,3000,2500),($NFLX,3000,2500),($SPY,500,2500)]" 50 \
  "Four Corners" "CORNERS" "Equal weight across a chip maker, a car company, a streamer and the market."

publish "[($AMC,3000,7000),($MSTR,10000,3000)]" 100 \
  "Diamond Hands" "DIAMOND" "AMC and MicroStrategy. You already know whether this one is for you."

publish "[($SPCX,500,6000),($NVDA,500,4000)]" 50 \
  "Orbital Access" "ORBIT" "SpaceX with a chip maker behind it. Two ways to own the same buildout."

publish "[($LULU,3000,6000),($NFLX,3000,4000)]" 25 \
  "Stretch Goals" "STRETCH" "Leggings and streaming. What people actually spend a Sunday on."

publish "[($NVDA,500,8000),($SGOV,3000,2000)]" 50 \
  "Chip Tax" "CHIPTAX" "Mostly NVDA, with a fifth in short treasuries so it is not a single name bet."

publish "[($NVDA,500,2000),($TSLA,3000,2000),($SPY,500,2000),($SLV,3000,2000),($AMC,3000,2000)]" 75 \
  "Everything Bagel" "BAGEL" "Five names, twenty percent each, no opinion whatsoever."

publish "[($BABA,3000,7000),($SPY,500,3000)]" 50 \
  "East Bound" "EAST" "Alibaba with an index behind it, for the version of this trade that can be slept on."

publish "[($DJT,10000,5000),($AMC,3000,3000),($MSTR,10000,2000)]" 100 \
  "Loud Money" "LOUD" "The three tickers that generate the most argument per dollar."

publish "[($SLV,3000,5000),($SGOV,3000,5000)]" 25 \
  "Metal and Bills" "METAL" "Silver and short treasuries, half each. The oldest two ideas there are."

publish "[($NFLX,3000,5000),($TSLA,3000,2500),($BABA,3000,2500)]" 50 \
  "Screen Time" "SCREEN" "A streamer, a car company that trades like a meme, and Alibaba."

echo "motifs after: $(count)"
echo
echo "The indexer picks these up on its next pass, within about a minute."
