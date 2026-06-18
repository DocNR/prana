# PRana 🐟

*A swarm strips a backlog fast.*

A cross-project directory of opt-in Nostr ([NIP-34](https://nips.nostr.com/34)) git
repos that surfaces their **correctly-open** issues by complexity, so contributors
can pull an item and fix it. The name is **PR** + *piranha*: lots of small
contributors descending on a shared backlog and stripping it clean.

This repo currently contains the correctness core and the tooling to validate it
against real on-relay data. See `CLAUDE.md` for full design context, the NIP-34
reference, and the roadmap.

## Layout

```
src/
  types.ts           NIP-34 event shapes + status kinds
  statusResolver.ts  the core: which issues are actually open (pure, deterministic)
  nip34.ts           shared NIP-34 parsing (coord, authority, relays, mention-vs-root)
  fetch.ts           live fetch + the signature-verification GATE -> resolver
  analyze.ts         runs over real nak output; surfaces data problems for the directory
test/
  statusResolver.test.ts   edge cases that bite naive readers
  fetch.test.ts            the verify gate + mention exclusion + live path (mocked)
  fixtures.ts              NIP-34 event builders
fetch.sh             pull real ngit events with `nak` into ndjson
docs/                design notes (e.g. contextvm-fit.md)
CLAUDE.md            context for working with Claude Code
```

## Quick start

```bash
npm install
npm test
```

To run against live data you need [`nak`](https://github.com/fiatjaf/nak) and `jq`:

```bash
zsh fetch.sh                                                  # -> repo/issues/statuses.ndjson
npm run analyze repo.ndjson issues.ndjson statuses.ndjson
```

`fetch.sh` is pinned to the ngit repo as a known-good target; edit `REPO`/`OWNER`
at the top to point it elsewhere.

## Fetch layer

`src/fetch.ts` is the live path and the **signature-verification gate**: every event
off a relay is run through `nostr-tools` `verifyEvent` and dropped on failure before
it reaches the resolver (which trusts `pubkey`). It does not hardcode relays — query
relays come from each repo's `30617` announcement. Two ways to run it:

```bash
# live: discover the announcement, then its issues + statuses, then resolve
npm run fetch live <ownerPubkey> <d-identifier> wss://relay.one wss://relay.two

# recorded: same verify->resolve pipeline over a captured snapshot (offline)
npm run fetch file repo.ndjson issues.ndjson statuses.ndjson
```

The recorded mode runs the identical pipeline over `fetch.sh` output, so a snapshot
captured once with `nak` can be replayed without network access.

## Worklist

`src/worklist.ts` is the contributor-facing view — the prototype demo. It ties the
pieces together: fetch (verified) → resolve (correctly-open) → complexity (S/M/L) →
claim state → a sorted list with quick wins first.

```bash
npm run worklist file repo.ndjson issues.ndjson statuses.ndjson [claims.ndjson]
npm run worklist live <ownerPubkey> <d-identifier> wss://relay.one wss://relay.two
```

```
S/M/L  claim             id        subject
  S    available         bc0f0222  Fix typo in README
  M    available         dad311f0  Save button 2px misaligned
  L    claimed:f3956696  e88bde65  Refactor storage and migrate across all modules

3 open  (2 available)  S:1 M:1 L:1
```

Complexity comes from a pluggable `ComplexityScorer` (`src/complexity.ts`) — a
deterministic heuristic by default, swappable for LLM triage where an API key exists.
Claim state comes from the claim fold (`resolveClaim`): claims (kind 31621) are
queried by their addressable `#d` issue id, pass the signature gate, then collapse to
available / `claimed:<pubkey>` / `contended`. Items sort available-first, then S → L
so quick wins surface. `live` discovery uses the relay-side author+`d` filter
(`discoverAnnouncement`), so older announcements aren't missed behind a relay's cap.

## Claim — publish a claim

`src/claim.ts` is the **write** half of the claim system: the worklist *reads* claims;
this *mints* one. `buildClaimEvent` is a pure builder for an unsigned kind-31621 event
the fold and gate accept (`["d", issueId]` target, matching `e`-root, NIP-40
`expiration` inside the 14-day horizon); signing and publishing are the thin edge.

```bash
# claim an issue for ~3 days (signs through your ngit login if you have one)
npm run claim -- <issueId> --ttl 3d

# release it again (frees the issue)
npm run claim -- <issueId> --release
```

Signing is **NIP-46 bunker** — the key never leaves your signer (e.g. Clave). With no
signer flag it reuses your **ngit login** (`nostr.bunker-uri` + `nostr.bunker-app-key`
in git config), so if you're already logged in it just works, no re-pairing. Otherwise
pass `--bunker 'bunker://…'` for a fresh pairing, or `--nsec <nsec>` to sign locally
(tests/CI; never logged). TTL accepts `3d` / `12h` / `30m` / `45s` and errors above the
14-day horizon — including a release, whose expiration must sit in the future or NIP-40
relays reject it as already expired. Publish relays come from `--relay` flags, else the
registry `prana` entry, else sensible defaults. The command prints the published event
id; re-run `npm run worklist` (or `npm run registry`) to watch the row flip between
`available` and `claimed:<pubkey>`.

## Registry — the cross-project directory

`src/registry.ts` spans the worklist across **many** repos — what makes PRana a
*directory*, not a single-repo lister. The repo set is a curated file (`registry.json`,
a JSON array or NDJSON of `{ owner, d, name?, relays? }`); the end state is a NIP-51
list event, but the consumer only needs `RepoRef[]`, so the source can swap later.

```bash
npm run registry registry.json wss://relay.fallback   # live, over every repo listed
```

It live-fetches each repo (`discoverAnnouncement` → `fetchRepo` → gated claim fold),
then `buildMultiRepoWorklist` merges everything into one list sorted **globally** —
the best quick wins across all repos rise to the top regardless of which repo they
live in. A repo that fails to fetch is reported and skipped, not fatal.

```
repo   S/M/L  claim      id        subject
beta     S    available  bc0f0222  Fix typo in docs
alpha    L    available  e88bde65  Refactor storage across all modules

2 open across 2 repo(s)  (2 available)  S:1 M:0 L:1
```

## Web UI

`src/server.ts` + `src/webui.ts` serve the registry worklist as a browsable,
filterable page (filter by size / repo / available-only; each subject deep-links to
the issue on njump). The render is pure and HTML-escaped — issue subjects are
untrusted nostr content and must not be able to inject script.

```bash
npm run serve registry.json        # then open http://localhost:8787
```

The page is the same `buildMultiRepoWorklist` output as the CLI, rendered for a
browser, with a 60s cache so a refresh doesn't re-hammer relays.

## What the resolver guarantees

- an issue with no status event defaults to **Open**
- only the issue author or a recognized maintainer can change status
- the most recent status wins; `created_at` ties break deterministically by event id
- a status for one issue never affects another

## What it deliberately does NOT do

Signature verification. The resolver trusts `event.pubkey`; verify signatures at the
fetch layer (`nostr-tools` `verifyEvent`) before feeding events in. See the security
note in `CLAUDE.md`.
