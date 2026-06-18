# CLAUDE.md — PRana

Context for working in this repo with Claude Code. Read this before changing code.
(Project name: **PRana** 🐟 — **PR** + *piranha*: a swarm of contributors stripping a
shared issue backlog clean. The public name drops the h; npm/dir name is lowercase
`prana`. It began as "PRanha" — same idea, same fish.)

## What this is

A cross-project **directory of opt-in Nostr (NIP-34) git repos** that surfaces
their *correctly-open* issues, tagged by complexity, so a contributor can pull an
item and fix it. The motivating use case: people with idle AI-subscription
capacity (use-it-or-lose-it quota) want to point that capacity at high-value small
tasks. NOTE: subscription quota is **not transferable** between users — there is no
"donate my tokens" mechanism. The realistic model is *capacity routing*: a smart
worklist that sends a contributor (working on their own subscription) to a vetted
backlog item. Design around that, not around escrow/verification of "donated" tokens.

## Status

- DONE + tested: the **status resolver** (`src/statusResolver.ts`) — the correctness
  core that decides which issues are actually open.
- DONE: an **analyzer** (`src/analyze.ts`) that runs over real `nak` output and
  surfaces the data problems below.
- DONE: `fetch.sh` — pulls real NIP-34 events with `nak` into ndjson.
- DONE + tested (offline): the **fetch layer** (`src/fetch.ts`) + shared parsing
  (`src/nip34.ts`). It is the signature-verification GATE — every event off a relay
  or recorded file passes `nostr-tools` `verifyEvent` and is dropped on failure
  before reaching the resolver. Relays are discovered from each repo's `30617`
  announcement (never hardcoded). CLI: `npm run fetch live <ownerPubkey> <d> <relay…>`
  or `npm run fetch file repo.ndjson issues.ndjson statuses.ndjson`.
- NEEDS LIVE VERIFICATION (local, needs `nak` + keys): confirm `fetch live` matches
  the recorded `analyze`/`fetch file` counts, and resolve **finding #4** on real data
  (are closures actually tracked via 1630-1633, or some other way?). See
  `docs/handoff.md`.
- NEXT (see Roadmap): claim primitive (CVM-aware); complexity inference; opt-in
  registry; web UI.

## Mental model (internalize this)

An issue is **not** simply "an issue for repo X." It is an event that *claims* a
relationship to one or more repo coordinates, whose status is **a separate fold over
events**, under a maintainer set that may span several keys. That's three
independent trust/grouping decisions, none of which a naive `kind:1621` list makes:

```
kind 1621 issue  --(a tag: root vs mention)-->  which repo does it belong to?
                 --(fold of 1630..1633)------>  is it actually open?
                 --(euc grouping)------------>  is this repo a fork of another?
```

The status fold is the reusable shape: replay all status events for a target, the
latest VALID one wins. You'll hit the same pattern for PR status later — build it
once (it lives in `resolveIssueStatus`).

## NIP-34 reference (the kinds we touch)

- `30617` repo announcement (addressable; coord = `30617:<pubkey>:<d-tag>`). Carries
  `relays`, `clone`, `maintainers`, and `r`+`euc` (earliest-unique-commit, used to
  group forks).
- `1621` issue. `a` tag(s) -> repo coord; optional `subject`; free-form `t` labels.
- `1617` patch / `1618` PR / `1619` PR-update (proposals; not yet handled here).
- `1630` Open / `1631` Resolved / `1632` Closed / `1633` Draft — status events that
  `e`-tag the issue/patch they govern.

Status rule (encoded in `statusResolver.ts`): an issue has no embedded status; its
state is the most recent (by `created_at`) status event signed by the **issue author
or a recognized maintainer** (repo owner + announcement `maintainers`). No valid
status event => defaults to **Open**.

## Four findings from real ngit data (drive design around these)

1. **Mention vs root.** An issue can carry an `a` tag to your repo marked `mention`
   while its `root` is a *different* repo. A naive `-t a=<coord>` filter over-captures.
   `issueTargets()` prefers the root-marked `a`; pure mentions are excluded.
2. **Fork / co-maintainer grouping.** The same repo-id ("ngit") exists under two
   pubkeys. Dedupe on `euc` (the `r ... euc` tag), not on `30617:pubkey:id`, or you
   list the repo twice and split its issues. The resolver now SURFACES a sibling
   fork owner's status as a non-authoritative `forkSignal` on `ResolvedIssue`
   (owners only; canonical state unchanged — see finding #4). Discovering those
   sibling owners live (querying relays by `euc`) is still pending — Phase 2 in
   `docs/handoff.md`; until then `fetch live` passes no siblings and `forkSignal`
   stays null in production.
3. **Label hygiene is poor.** Real `t` tags include `bug`, `enhancement`, plus
   `compati` / `compatability` / `compatibility` (three spellings), and most issues
   have no label at all. You CANNOT derive complexity from existing labels. Plan for
   self-inference (LLM triage + linked-diff size), with maintainer-asserted labels as
   an optional later layer.
4. **Default-Open trap.** With no status events pulled, every issue renders "open,"
   including long-shipped ones. Always resolve status before display; if resolved
   counts look implausibly low, investigate whether closures are tracked by some
   mechanism other than 1630-1633.

## Security boundary (do not regress)

`statusResolver.ts` TRUSTS `event.pubkey`. Signature verification must happen at the
fetch/ingest layer (use `nostr-tools` `verifyEvent`, drop failures) BEFORE events
reach the resolver. Without it, a forged "resolved-by-maintainer" event flips issues.
Keep the resolver pure and I/O-free; verification belongs upstream.

## Conventions

- Test-first / test-alongside. The resolver's edge cases live in
  `test/statusResolver.test.ts`; add a failing test before changing behavior.
- Determinism matters: `created_at` is attacker-controllable and can tie. Sort by
  `created_at` then break ties by event id; surface ambiguity rather than silently
  picking (`ambiguousTimestamp`).
- Minimal diffs, incremental commits. Keep the resolver the single source of truth
  for status logic — do not duplicate the fold elsewhere.

## How to run

```bash
npm install
npm test                 # vitest — resolver edge cases
zsh fetch.sh             # pull real ngit events -> repo/issues/statuses.ndjson (needs `nak` + `jq`)
npm run analyze repo.ndjson issues.ndjson statuses.ndjson
```

`nak` install: `go install github.com/fiatjaf/nak@latest` or a release binary from
github.com/fiatjaf/nak. The `sonic only supports go1.17~1.23` warning from nak is
harmless.

## Roadmap (suggested next slices)

1. **Fetch layer** (`src/fetch.ts`): `nostr-tools` subscribe -> `verifyEvent` ->
   resolve, reading query relays from each repo's `30617` announcement (don't
   hardcode relays). Replaces the manual `nak` two-step.
2. **Claim primitive**: NIP-34 has no assignee concept; two contributors burning
   capacity on one issue is the core failure mode. Design a claim event (custom kind
   + expiry/TTL) and its semantics before building UI around it. Shape it
   **CVM-aware** so claim/release/status can later ride MCP-over-Nostr — see
   `docs/contextvm-fit.md` (adopt-ready; sequence the CVM front door behind the
   claim fold, don't gate on whether the NIP is merged).
   - DONE: the READ side — claim fold (`src/claimResolver.ts`) + ingest gate
     (`src/claimFetch.ts`, `isAdmissibleClaim`), both tested.
   - DONE: the WRITE side — `src/claim.ts` (`npm run claim`): pure `buildClaimEvent`
     (unit-tested to pass the fold + gate) plus a thin signing/publish edge — NIP-46
     bunker signing that reuses the **ngit login** (`nostr.bunker-uri` +
     `nostr.bunker-app-key`) when present, explicit `--bunker`, or `--nsec` local
     fallback; `SimplePool` publish. NOTE: a release needs a FUTURE `expiration` (now +
     ttl), not `now` — NIP-40 relays drop already-expired events. Exercised live by
     claiming/releasing PRana's own issue #1. The CVM front door is still pending.
3. **Complexity inference**: triage pass over issue text + linked diff size -> S/M/L.
4. **Opt-in registry**: start with a curated NIP-51 list of repo coords; later let
   maintainers self-register, with a per-repo "accepts agent contributions" toggle.
5. **Web UI**: filter by size / language / repo; "claim"; deep-link to clone url.
