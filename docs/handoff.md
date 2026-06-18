# Handoff — fetch layer live verification

State as of the latest push to `claude/prana-continuation-ixmkl6`.

## Where things are

- Offline base is green: `npm run typecheck && npm test` → 24 passing.
- The fetch layer (`src/fetch.ts`) and shared parsing (`src/nip34.ts`) are built and
  unit-tested with an injected verifier/query (no network). It is the
  signature-verification gate in front of the resolver.
- What has NOT happened yet: running it against live relays, and resolving finding #4
  on real data. That needs a machine with `nak`, `jq`, and Nostr keys.

## What the local session should do

1. `npm run typecheck && npm test` — confirm 24 passing.
2. Capture a snapshot: `zsh fetch.sh` (writes repo/issues/statuses.ndjson for ngit).
3. Cross-check old vs new over the SAME snapshot — counts should agree:
   - `npm run analyze repo.ndjson issues.ndjson statuses.ndjson`
   - `npm run fetch file repo.ndjson issues.ndjson statuses.ndjson`
4. Run the live path (needs real relays):
   `npm run fetch live a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d ngit wss://relay.ngit.dev wss://relay.damus.io`
   Confirm it discovers the announcement, fetches issues by coord then statuses by
   issue id, and that resolved counts match step 3. Watch the "dropped (bad sig)"
   line — that's the security gate; report anything it drops.
5. Finding #4 (default-Open trap): on real data, are closures tracked via kind
   1630-1633, or is "resolved" happening some other way (patch merged, or nothing)?
   Use `nak` to poke. If resolved counts look implausibly low, dig in and report why.
6. If the snapshot is a good grounding fixture, propose committing a trimmed version
   under `test/` so future offline work has real event shapes.

Report what matched, what didn't, and anything surprising. Don't push without an OK.

## After verification (next slice)

Claim primitive (roadmap #2), designed **CVM-aware** — see `docs/contextvm-fit.md`.
Shape claim/release/status so they can ride MCP-over-Nostr later without betting the
core on the unmerged CVM NIP (#2246).

## Next: Phase 2 — live euc-group discovery

Phase 1 (branch `euc-group-fork-signal`) landed: the resolver SURFACES `forkSignal`
when given `forkOwners` (sibling 30617 owners, owners-only by design), proven by
`test/realFixture.test.ts` against the real `a34b99f` close. What is NOT done:
discovering those siblings live — so in production `fetchRepo`/`fetch live` pass no
siblings and `forkSignal` is always null. The mechanism is exercised only by tests.

Build `discoverSiblings(announcement, relays, query)` that, given a repo's `euc`
(`repoEuc()`), finds other 30617 announcements sharing it and returns
`{ owner, coord }[]` (excluding self), then pass them to `fetchRepo({ forkOwners })`.

Open question to verify live (mirror how `discoverAnnouncement` was verified): do
relays index the `euc` so a server-side filter works, or must siblings be discovered
another way (a maintainers graph / the opt-in registry)? `30617` stores euc as
`["r", "<euc>", "euc"]`; test whether `nak req -k 30617 -t r=<euc> wss://relay.ngit.dev`
returns the group before committing to that path. If relays don't index `r`, fall
back to the curated registry (roadmap #4) as the sibling source.
