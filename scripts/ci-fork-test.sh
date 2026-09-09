#!/usr/bin/env bash
#
# Run one group of fork tests against a local anvil, and treat the upstream
# refusing service as what it is rather than as a test failure.
#
# The problem this exists for is written up in CLAUDE.md under "the rpc rate
# limits CI". The short version: this chain has one public rpc, there is no paid
# one, and it 429s under the load of a full suite. Anvil already reduces that to
# one fetch per distinct slot, and it cannot reduce it to none, because the chain
# prunes state within the hour so no block can be pinned and no cache can be
# carried between runs. Measured, not assumed: anvil's own --dump-state does not
# capture fork fetched accounts either, so that route is closed too.
#
# **What this does not do is retry a failing test.** It retries the fetch, and
# only when anvil's log proves the fetch was refused. A test that fails for any
# other reason fails on the first attempt, immediately, with no retry and no
# delay, which is the behaviour that matters: a real break must not be papered
# over by a loop.
#
#   scripts/ci-fork-test.sh "<name>" <forge args...>
#
set -uo pipefail

NAME="$1"; shift

RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
LOCAL="http://127.0.0.1:8545"

# Nothing in this script's children may reach the public rpc directly. The job
# sets FOUNDRY_ETH_RPC_URL to it for the steps that legitimately want it, and a
# foundry tool that falls back to that env var talks to the endpoint anvil is
# here to shield. That is not hypothetical: it is what made this script think
# anvil was already running when nothing was listening at all.
export FOUNDRY_ETH_RPC_URL="$LOCAL"
export ETH_RPC_URL="$LOCAL"
LOG=/tmp/anvil.log
PIDFILE=/tmp/anvil.pid
ATTEMPTS="${CI_FORK_ATTEMPTS:-3}"

# The verdict this script reached, for the summary step to read rather than
# re-derive. It used to grep the whole of anvil's log for "429" on its own, and
# a log full of hex and block numbers matches that string almost every run, so
# it announced "every test failure above is a rate limit, not a contract bug"
# over failures this script had already ruled were real. Two genuinely broken
# tests sat red on main for four commits behind that reassurance. One evidence
# gate, written down once, read by whoever needs it.
VERDICT="${CI_FORK_VERDICT:-/tmp/rpc-verdict}"

# Failures that do not look like the endpoint, written down separately.
#
# The verdict above is per attempt and boolean: one 429 anywhere in anvil's log
# during an attempt marks the whole attempt refused, and the summary then says
# every failure above is a rate limit. That was true often enough to be
# believed and it is not always true. A run with 85 passing, one 429 and seven
# genuinely broken tests read as "all rpc", and two real failures hid behind it
# for eight commits.
#
# A refused fetch surfaces as `EvmError: Revert` in whatever was reading
# storage, or names the 429 outright. Anything else that fails is a test
# failing on its own terms: `IndexCreated != expected IndexCreated` and
# `SlippageTooHigh(...)` are not shapes an http error takes. That is a
# heuristic rather than a proof, so these are reported as worth reading rather
# than as a verdict.
SUSPECT="${CI_FORK_SUSPECT:-/tmp/rpc-suspect}"

# Anvil's outbound rate, not forge's. Forge never speaks to the public rpc once
# anvil is in front of it, so this is the only dial that reaches the endpoint
# doing the refusing. Deliberately low: the total number of requests is already
# minimal, and what trips the limit is the burst.
CUPS="${CI_ANVIL_CUPS:-40}"

# Asked over http rather than with `cast`, deliberately.
#
# `cast block-number --rpc-url http://127.0.0.1:8545` answered 0 with nothing
# listening on that port, because it fell back to FOUNDRY_ETH_RPC_URL and got a
# block number off the public rpc. The script read that as "anvil is up", never
# started one, and every test failed to connect. A raw eth_chainId to the exact
# url has no fallback to get wrong.
up() {
  curl -s -m 5 -X POST "$LOCAL" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null |
    grep -q '"result"'
}

block_number() {
  curl -s -m 5 -X POST "$LOCAL" \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' 2>/dev/null |
    sed -n 's/.*"result":"\([^"]*\)".*/\1/p'
}

stop_anvil() {
  if [ -f "$PIDFILE" ]; then
    kill -TERM "$(cat "$PIDFILE")" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
      sleep 1
    done
    rm -f "$PIDFILE"
  fi
}

# One go at forking. Returns 0 once anvil answers, 1 if it never does.
fork_once() {
  stop_anvil
  : > "$LOG"
  setsid anvil --fork-url "$RPC" --port 8545 \
    --compute-units-per-second "$CUPS" \
    --retries 10 --fork-retry-backoff 10 --timeout 90000 \
    >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 90); do
    if up; then
      echo "anvil forked at block $(block_number)"
      return 0
    fi
    # Anvil exits rather than hanging when the fork itself is refused, and it
    # says so on a line of its own: "Error: failed to get fork block number".
    # Waiting out the remaining iterations for a process that has already given
    # up costs three minutes per attempt and tells us nothing.
    #
    # Asked of the log rather than of the pid, deliberately. `setsid cmd &`
    # gives $! the pid of setsid, which is anvil's own only because a
    # non-interactive shell has no job control and setsid therefore execs in
    # place instead of forking. That is true here and it is not a thing to rest
    # on: with job control the pid would be a corpse immediately and this would
    # break out before anvil ever bound a port.
    grep -q "^Error:" "$LOG" 2>/dev/null && break
    sleep 2
  done
  return 1
}

# Starting anvil is itself a request to the endpoint that refuses us, and it is
# the one request that cannot be retried by anything downstream: `anvil
# --fork-url` with no block asks eth_blockNumber first, and a 429 there kills
# the process before it binds a port. That is not hypothetical, it is how the
# run on 2aa6da8 ended: the test retry worked, detected the 429, waited, and
# then died on `start_anvil || exit 1` with an attempt still in hand.
#
# So the same evidence gate applies here. A fork refused with a 429 is waited
# out and tried again; a fork that failed for any other reason fails now.
start_anvil() {
  local tries="${CI_ANVIL_ATTEMPTS:-3}"
  local t pause
  for t in $(seq 1 "$tries"); do
    fork_once && return 0

    if ! grep -q "429" "$LOG" 2>/dev/null; then
      echo "::error::anvil never became ready, and the public rpc did not refuse it."
      echo "::error::Nothing here is a rate limit. Its log:"
      tail -40 "$LOG"
      return 1
    fi

    if [ "$t" -eq "$tries" ]; then
      echo refused > "$VERDICT"
      echo "::error::The public rpc refused to let anvil fork at all, $tries times."
      echo "::error::This is the endpoint, not the code. Its log:"
      tail -40 "$LOG"
      return 1
    fi

    # Longer than the test retry waits. A fork start is a single
    # eth_blockNumber, the cheapest request there is, so being refused for one
    # means the window is fully shut and only time opens it.
    pause=$((t * 30))
    echo "::warning::The public rpc refused anvil's fork with a 429. Waiting ${pause}s."
    tail -10 "$LOG"
    sleep "$pause"
  done
  return 1
}

# Only a 429 written since this attempt started counts. Anvil's log is appended
# to across attempts, so a refusal from an earlier attempt that already
# succeeded on retry must not make the next real failure look like one too.
refused_since() {
  local from="$1"
  tail -n "+$from" "$LOG" 2>/dev/null | grep -q "429"
}

# Failing tests whose reason is not a shape a refused fetch takes. Written to a
# file as well as printed, so the job summary can repeat it at the end where it
# is actually read rather than buried under everything the runner prints.
suspects() {
  local out="$1"
  : > "$SUSPECT"
  [ -f "$out" ] || return 0
  grep -E '^\[FAIL' "$out" 2>/dev/null \
    | grep -v '429' \
    | grep -vE 'EvmError: Revert' > "$SUSPECT" || true
  [ -s "$SUSPECT" ] || return 0
  echo "::warning::Some of these do not look like the rpc, and are worth reading:"
  while IFS= read -r line; do echo "::warning::  $line"; done < "$SUSPECT"
}

# The api-routes job needs no chain and never calls this. Anvil is started here
# rather than in its own step so a retry can restart it.
up || start_anvil || exit 1

touch "$LOG"

OUT=/tmp/forge-out.log

for attempt in $(seq 1 "$ATTEMPTS"); do
  mark=$(( $(wc -l < "$LOG" 2>/dev/null || echo 0) + 1 ))

  echo "::group::$NAME (attempt $attempt of $ATTEMPTS)"
  # pipefail, or the status would be tee's and every failure would look like a
  # success. Kept so the failing test names can be read back below.
  set -o pipefail
  forge test "$@" --rpc-url "$LOCAL" 2>&1 | tee "$OUT"
  status=$?
  set +o pipefail
  echo "::endgroup::"

  if [ "$status" -eq 0 ]; then
    [ "$attempt" -gt 1 ] && echo "$NAME passed on attempt $attempt."
    exit 0
  fi

  if ! refused_since "$mark"; then
    echo real > "$VERDICT"
    suspects "$OUT"
    echo "::error::$NAME failed and the public rpc did not refuse anvil during it."
    echo "::error::Nothing here is a rate limit. Read the failure above as real."
    exit "$status"
  fi

  echo "::warning::$NAME failed while the public rpc was refusing anvil with a 429."
  echo "::warning::That surfaces as 'EvmError: Revert' in whichever test was reading"
  echo "::warning::storage, which is not what happened. See CLAUDE.md."
  suspects "$OUT"
  tail -20 "$LOG"

  if [ "$attempt" -eq "$ATTEMPTS" ]; then
    echo refused > "$VERDICT"
    echo "::error::Still refused after $ATTEMPTS attempts. This is the endpoint, not the code."
    exit "$status"
  fi

  # A fresh anvil, because the one that was refused has holes in its cache where
  # the refused slots should be, and it will not go back for them.
  backoff=$((attempt * 30))
  echo "Waiting ${backoff}s and forking again."
  sleep "$backoff"
  start_anvil || exit 1
done
