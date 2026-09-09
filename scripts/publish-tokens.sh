#!/usr/bin/env bash
# Launch the starting basket tokens on a real chain, for gas and nothing else.
#
# The counterpart to publish-motifs.sh, and it works for the same reason:
# `launch` creates the curve and its vault and publishes the index behind it,
# and it buys nothing. `launchAndBuy` is the one that needs USDG, and it is not
# used here, so filling an empty Tokens page costs only gas.
#
#   MOTIF_FACTORY=0x... PRIVATE_KEY=0x... RPC=https://rpc.mainnet.chain.robinhood.com \
#     scripts/publish-tokens.sh
#
# **Set MOTIF_FACTORY on the api and redeploy it before running this.** The
# indexer only scans forward from its cursor and skips launch logs entirely
# while it has no factory configured, so tokens launched before the api knows
# about the factory are stepped over and never appear. Recovering from that
# means wiping the cursor and reindexing from scratch.
set -uo pipefail

RPC=${RPC:-https://rpc.mainnet.chain.robinhood.com}
FACTORY=${MOTIF_FACTORY:-}
KEY=${PRIVATE_KEY:-}

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

# Ten thousand usdg, the same raise the fork tests use.
THRESHOLD=10000000000

if [ -z "$FACTORY" ] || [ -z "$KEY" ]; then
  echo "usage: MOTIF_FACTORY=0x... PRIVATE_KEY=0x... [RPC=...] scripts/publish-tokens.sh" >&2
  exit 1
fi

if [ "$(cast code "$FACTORY" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
  echo "no contract at MOTIF_FACTORY=$FACTORY on $RPC" >&2
  exit 1
fi

SENDER=$(cast wallet address --private-key "$KEY" 2>/dev/null)
echo "launching as $SENDER"
echo "gas balance   $(cast balance "$SENDER" --rpc-url "$RPC") wei"

count() { cast call "$FACTORY" 'count()(uint256)' --rpc-url "$RPC" 2>/dev/null | cut -d' ' -f1; }

launch() { # legs feeBps name symbol description
  local before after
  before=$(count)
  cast send "$FACTORY" \
    "launch((address,uint24,uint16)[],uint16,uint256,string,string,string,string)" \
    "$1" "$2" "$THRESHOLD" "$3" "$4" "$5" "" \
    --private-key "$KEY" --rpc-url "$RPC" > /dev/null
  after=$(count)
  if [ -z "$after" ] || [ "$before" = "$after" ]; then
    echo "  FAILED to launch $4: count stayed at ${before:-unreadable}" >&2
    exit 1
  fi
  echo "  launched $4 (#$before)"
}

echo "basket tokens before: $(count)"

launch "[($AMC,3000,6000),($DJT,10000,4000)]" 100 \
  "Paper Hands" "PAPER" "AMC and Trump Media. Named honestly."

launch "[($SGOV,3000,7000),($SPY,500,3000)]" 25 \
  "Quiet Compounding" "QUIET" "Short treasuries and the index. Nothing happens here on purpose."

launch "[($NVDA,500,5000),($MSTR,10000,5000)]" 50 \
  "Two Chips" "TWOCHIPS" "Half a chip maker, half a company that buys bitcoin."

launch "[($NFLX,3000,5000),($LULU,3000,3000),($TSLA,3000,2000)]" 50 \
  "Long Weekend" "WEEKEND" "Streaming, leggings and a car. A Saturday in three tickers."

launch "[($SGOV,3000,5000),($DJT,10000,5000)]" 75 \
  "Bar Bell" "BARBELL" "The safest thing on the chain next to the loudest. Half each."

launch "[($TSLA,3000,4000),($SPCX,500,3000),($MSTR,10000,3000)]" 100 \
  "Full Send" "FULLSEND" "Tesla, SpaceX and MicroStrategy. For people who mean it."

echo "basket tokens after: $(count)"
echo
echo "The indexer picks these up on its next pass, within about a minute."
