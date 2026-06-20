# Claim primitive — design note

Status: **IMPLEMENTED.** The claim fold (`src/claimResolver.ts`), the ingest /
admissibility gate (`src/claimFetch.ts`, `isAdmissibleClaim`), the write path
(`src/claim.ts`, `buildClaimEvent`), and the web-UI claim/release button are all built
and tested. This note is the original design rationale; the as-built reality differs in
a few places (see "As built" below). The kind number `31621` is still **PROVISIONAL and
unreserved** and must be reserved before cross-client use. One-page kinds overview:
`docs/event-kinds.md`.

## As built (where this note is now out of date)

- **No `a` tag.** The shipped claim carries `d`, `e` (root), `expiration`, `status` only
  (`buildClaimEvent`). The `["a", ...]` repo-coord tag in the provisional shape below was
  dropped; the `e`-tag to the issue is enough, and the repo is reachable from the issue.
- **TTL is settled:** default 3 days, hard max 14 days (`DEFAULT_TTL_SECONDS` /
  `MAX_TTL_SECONDS`), not the "unsettled 48-72h" noted further down.
- **Admissibility gate added:** ingest drops a claim whose `expiration` exceeds
  `now + 14d` or whose `created_at` is future-dated (the anti-"parking" defense), on top
  of the signature check.
- **Contention policy chosen:** first-come canonical holder (the option proposed below),
  implemented in the fold.
- Still open: reserve the kind number, auto-release-on-resolution (currently implicit:
  the directory stops showing claims on non-open issues), and maintainer override (deferred).

## The problem this solves

NIP-34 has no assignee concept. PRana's core failure mode is two contributors (each
burning their own subscription quota) fixing the *same* issue — wasted capacity, the
exact thing the directory exists to prevent. We need a way for a contributor (or their
agent) to signal "I'm on this" that others can see *before* they start, and that
expires on its own so an abandoned claim doesn't park an issue forever.

A claim is **advisory, not a lock.** Nostr has no global mutex; we can't *prevent* a
second claim. The directory's job is to make existing claims visible and pick a
canonical holder so the second contributor is routed elsewhere. Treat collisions as
something to *surface*, not something the protocol guarantees away — same discipline as
`ambiguousTimestamp` in the status resolver.

## Event shape (provisional)

A claim is an **addressable** event (kind range 30000-39999) so NIP-01 replaceability
gives us "one active claim per (pubkey, issue)" for free: re-claiming, refreshing the
TTL, and releasing are all just newer events at the same coordinate.

```
kind: 31621   // PROVISIONAL. mnemonic: addressable claim over a 1621 issue.
              // MUST be reserved before cross-client use; check the kinds registry.
pubkey: <contributor>           // the claimant; claims are self-asserted
created_at: <unix>
tags:
  ["d", "<issue-id>"]           // addressable key => latest claim per (pubkey, issue)
  ["e", "<issue-id>", "", "root"]   // which issue (mirrors status events)
  ["a", "30617:<pk>:<d>", "", "root"]   // which repo coord
  ["expiration", "<unix>"]      // NIP-40 TTL; relays MAY drop after this
  ["status", "claimed"]         // claimed | released  (see lifecycle)
content: ""                      // optional free note ("ETA tomorrow", PR link later)
```

Why these choices:
- **Addressable, not ephemeral.** Ephemeral (20000-29999) events aren't stored; a
  claim must persist for its TTL so others can see it. Addressable persists *and*
  auto-replaces the holder's prior claim.
- **NIP-40 `expiration`** lets cooperating relays GC expired claims, but we do NOT
  trust the relay to enforce it — the fold recomputes "active" from `expiration` vs
  now (relay-side GC is an optimization, the resolver is the authority).
- **`d` = issue id** keys replaceability to the issue, so a contributor holds at most
  one live claim per issue and refreshing the TTL is a no-friction re-publish.

## The claim fold (same shape as the status resolver)

CLAUDE.md flagged the status fold as the reusable pattern ("you'll hit it again for PR
status"). The claim fold IS that pattern again — build it the same way, keep it pure:

For one issue, over all its claim events:
1. Verify signatures upstream (the fetch gate already does this); the resolver trusts
   `pubkey`.
2. Group by claimant pubkey; addressable replaceability means keep the latest
   `created_at` per pubkey (tie-break by event id, like the status fold).
3. A claim is **ACTIVE** iff `status == "claimed"` AND `now < expiration`.
4. The issue's claim state:
   - no active claims  -> **unclaimed** (available)
   - exactly one       -> **claimed** by that pubkey until `expiration`
   - two or more        -> **contended**: pick the canonical holder as the earliest
     active claim by `created_at` (first-come), and surface the contention so a UI can
     warn rather than silently route two people in. Mirrors `ambiguousTimestamp`.

Output shape, parallel to `ResolvedIssue`:

```ts
interface ClaimState {
  issueId: string;
  holder: string | null;     // canonical claimant pubkey, or null if unclaimed
  expiresAt: number | null;
  contended: boolean;        // >1 active claim from different pubkeys
  active: ClaimEvent[];      // all current active claims, for inspection
}
```

## Lifecycle

- **claim**: publish kind 31621, `status=claimed`, `expiration = now + TTL`.
- **refresh**: re-publish (same `d`) with a later `expiration`. Replaces prior.
- **release**: publish with `status=released` (replaces the claim at that coordinate;
  the fold sees no active claim). Explicit release frees the issue before TTL.
- **auto-expire**: no release needed — once `now >= expiration` the fold treats it as
  unclaimed. This is what protects against abandoned claims.
- **auto-release on resolution** (open question): when the issue goes `resolved`/
  `closed` (status fold) or a patch (1617) lands referencing it, the claim is moot.
  The directory can just stop showing claims on non-open issues; whether the claimant
  should also publish an explicit release is a UX call.

**TTL default**: unsettled. The use case is weekly-resetting quota, so a few days
(48-72h) is a plausible default — long enough to actually do a small task, short
enough that an abandoned claim frees up within the same quota week. Confirm against
real backlog item sizes once finding #4 data is in.

## Security / trust

- Claims are **self-asserted** — anyone can claim any issue. That's fine; a claim is a
  coordination hint, not an authority grant (unlike status events, which are
  maintainer/author-gated). The only thing we verify is the signature (so a claim is
  attributable to a real pubkey and can't be forged onto someone else's identity).
- **Maintainer override** (open question): should a maintainer be able to force-release
  or reassign a claim (e.g. claimant went dark just under TTL)? Keep v1 without it —
  TTL handles the common case — but leave room: a maintainer-signed release referencing
  another pubkey's claim coordinate could be honored by the fold later.
- Same boundary as everything else: verification happens at the fetch gate, the fold
  stays pure and I/O-free.

## CVM fit (why it's shaped this way)

Keep the **claim event itself a plain Nostr event** that PRana folds — NOT a CVM tool
call. That keeps the system non-custodial: claims live on relays, attributable to the
contributor's key, and survive even if the PRana directory disappears. CVM is the
*agent-facing convenience layer on top*, not the source of truth.

The natural CVM mapping (see `docs/contextvm-fit.md`): the PRana worklist is exposed
as an MCP server over Nostr, with tools roughly:
- `list_open_issues(filter)` -> open + unclaimed issues by complexity
- `claim(coord, issueId, ttl)` -> returns the claim-event template; the agent signs &
  publishes with its OWN key (server never holds the key), or publishes directly and
  the server just reads the relay
- `release(coord, issueId)` / `report_status(...)`

Because the claim is signed by the same Nostr identity the contributor uses for NIP-34,
a claim made via a CVM call is the same event as one made by hand — one source of
truth, two front doors. This is the payoff of designing the event first and treating
CVM as transport, and the reason we don't bet the event format on the unmerged CVM NIP.

## Open questions (resolve before coding)

1. Reserve the kind number (NIPs repo) — 31621 is a placeholder.
2. TTL default — pin once finding #4 tells us real item sizes.
3. Auto-release on resolution: implicit (directory hides) vs explicit release event.
4. Maintainer override: in v1 or deferred?
5. Contention policy: first-come canonical holder (proposed) vs show-all-equally.

## Suggested first code slice (after sign-off)

`src/claimResolver.ts` + `test/claimResolver.test.ts`, mirroring the status resolver:
a pure `resolveClaim(issueId, claimEvents, now)` -> `ClaimState`, with the fetch layer
querying kind 31621 by `#e` issue id and gating signatures exactly as it does for
status. No UI, no publish path yet — fold first, like we did for status.
