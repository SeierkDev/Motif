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
SPY=0x117cc2133C37B721f49dE2A7A74833232b3b4C0C
MSTR=0xEC262a75E413fAfD0dF80480274532c79D42dA09
NFLX=0xe0444ef8Bf4Ed74F74Fd73686e2DdF4C1C5591e8

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

launch() { # key legs feeBps name symbol description spend minOut
  cast send "$ROUTER" \
    "createAndBuy(address,(address,uint24,uint16)[],uint16,string,string,string,uint256,uint256[])" \
    "$USDG" "$2" "$3" "$4" "$5" "$6" "$7" "$8" \
    --private-key "$1" --rpc-url "$RPC" > /dev/null
  echo "  launched $5"
}

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

# A second buyer on one of them, so holder counts are not all one.
cast send "$ROUTER" "buy(uint256,uint256,uint256[])" 0 900000000 "[0,0]" \
  --private-key "$B_KEY" --rpc-url "$RPC" > /dev/null
echo "  second buyer on #0"

echo "motifs: $(cast call "$ROUTER" 'indexCount()(uint256)' --rpc-url "$RPC")"
