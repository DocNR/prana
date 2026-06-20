# PRana 🐟

*A swarm strips a backlog fast.*

A cross-project directory of opt-in Nostr ([NIP-34](https://nips.nostr.com/34)) git
repos that surfaces their **correctly-open** issues by complexity, so contributors
can pull an item and fix it. The name is **PR** + *piranha*: lots of small
contributors descending on a shared backlog and stripping it clean.

## Why

Plenty of developers have idle, use-it-or-lose-it capacity on an AI coding
subscription, and plenty of open source projects have a backlog of small, well-scoped
issues nobody has picked up. PRana routes the first at the second: a worklist that
points a contributor (working on their own subscription, a person or their AI agent)
at a vetted backlog item across many repos.

This is **capacity routing, not token donation.** Subscription quota is not
transferable between users, there is no escrow and no "donate my tokens" step. You
spend your own capacity on a task you choose; PRana just makes the right task easy to
find and keeps two people from doing the same one.

## Status

The full read path (resolver, signature-verification fetch gate, complexity scoring,
cross-repo registry, worklist), the claim system (read fold + ingest gate + write CLI
+ web button), and a browsable web UI are all built and tested. See `CLAUDE.md` for
full design context, the NIP-34 reference, and the roadmap, and `docs/event-kinds.md`
for the one-page kinds reference.

## Layout

```
src/
  types.ts           NIP-34 event shapes + status/claim kinds
  nip34.ts           shared NIP-34 parsing (coord, authority, relays, mention-vs-root)
  statusResolver.ts  the core: which issues are actually open (pure, deterministic)
  fetch.ts           live fetch + the signature-verification GATE -> resolver
  complexity.ts      S/M/L scorer (pluggable; deterministic heuristic by default)
  claimResolver.ts   claim fold: available / claimed / contended (pure)
  claimFetch.ts      claim ingest gate (signature + anti-parking admissibility)
  claimEvent.ts      buildClaimEvent: the unsigned kind-31621 claim template
  claim.ts           write CLI: sign + publish a claim/release (npm run claim)
  worklist.ts        single-repo contributor view (fetch -> resolve -> score -> claim)
  registry.ts        cross-repo directory: merge many repos into one worklist
  server.ts/webui.ts browsable, filterable web page (read-only; the client signs claims)
  analyze.ts         runs over real nak output; surfaces data problems
test/                unit tests for each of the above (resolver edge cases, the gate, the folds, render)
fetch.sh             pull real ngit events with `nak` into ndjson
docs/                design notes (event-kinds.md, claim-primitive.md, contextvm-fit.md, ...)
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

`src/server.ts` + `src/webui.ts` serve the registry worklist as a browsable page:
filter by size / repo / available-only, sortable columns (size sorts S to L), a sticky
header with a live "showing N of M" count, a copy-id button, and a responsive layout.
Each subject and repo name deep-links to gitworkshop.dev. The render is pure and
HTML-escaped, because issue subjects are untrusted nostr content and must not be able to
inject script.

```bash
npm run serve registry.json        # then open http://localhost:8787
```

The page is the same `buildMultiRepoWorklist` output as the CLI, rendered for a
browser, with a 60s cache so a refresh doesn't re-hammer relays.

### Claim from the web

Each available row has a **Claim** button (and a **Release** button once you hold it),
plus a clone cell with two copy chips: an **ngit** `nostr://` clone (the contribution
path, so your PR lands back on nostr) and the conventional **mirror** (github/codeberg).
The button is signed by *your own* signer; the server never touches a key and stays
read-only. We load [`window.nostr.js`](https://github.com/fiatjaf/window.nostr.js)
(WNJ), which exposes a NIP-07 `window.nostr` and, when no extension is present, offers a
NIP-46 bunker/QR flow (e.g. Clave). On click, the browser stamps the time onto the
server-built claim skeleton (`buildClaimEvent` is the single source of truth), calls
`window.nostr.signEvent`, and publishes the signed event over a raw WebSocket to the
**registry-trusted** relays; the row then flips optimistically once a relay confirms.

Security: untrusted strings are escaped and JSON is embedded only in `data-*` attributes
(never a `<script>`); clone chips are copy-to-clipboard buttons, never `href`s, and the
gitworkshop links are built only from `npub`/`nevent` encodings plus an escaped host;
publish relays are parsed, `wss:`-only, and capped; WNJ is pinned with an SRI hash. See
`docs/superpowers/specs/2026-06-18-web-claim-button-design.md` (incl. the adversarial
review) for the full threat model.

## What the resolver guarantees

- an issue with no status event defaults to **Open**
- only the issue author or a recognized maintainer can change status
- the most recent status wins; `created_at` ties break deterministically by event id
- a status for one issue never affects another

## What it deliberately does NOT do

Signature verification. The resolver trusts `event.pubkey`; verify signatures at the
fetch layer (`nostr-tools` `verifyEvent`) before feeding events in. See the security
note in `CLAUDE.md`.
