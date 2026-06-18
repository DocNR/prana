#!/usr/bin/env zsh
# Pull ngit's NIP-34 events into ndjson files. Run: zsh fetch.sh
# Self-contained: sets its own vars, no mapfile, no env dependence.
set -e

REPO="30617:a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d:ngit"
OWNER="a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d"
RELAY="wss://relay.ngit.dev"
EXTRA="wss://relay.damus.io"   # most ngit issues carry a damus relay hint

echo "1/3 repo announcement -> repo.ndjson"
nak req -k 30617 -a "$OWNER" -d ngit "$RELAY" "$EXTRA" > repo.ndjson

echo "2/3 issues -> issues.ndjson"
nak req -k 1621 -t a="$REPO" "$RELAY" "$EXTRA" > issues.ndjson

echo "3/3 statuses (by issue id, the robust path) -> statuses.ndjson"
# build "-e <id> -e <id> ..." without mapfile; ${=VAR} forces zsh word-splitting
EFLAGS=$(jq -r '.id' issues.ndjson | sed 's/^/-e /' | tr '\n' ' ')
nak req -k 1630 -k 1631 -k 1632 -k 1633 ${=EFLAGS} "$RELAY" "$EXTRA" > statuses.ndjson

echo "done. issues=$(wc -l < issues.ndjson) statuses=$(wc -l < statuses.ndjson)"
echo "now run: node analyze.mjs repo.ndjson issues.ndjson statuses.ndjson"
