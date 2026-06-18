# Claim fold (`resolveClaim`) — design spec

**Status:** approved design, ready for an implementation plan.
**Scope:** the pure claim fold only — one module mirroring `src/statusResolver.ts`.
**Builds on:** `docs/claim-primitive.md` (the broader event/lifecycle/CVM design). This
spec narrows that note to the first, fully-testable code slice.
**Hardened by** an adversarial design review (2026-06-17) — see *Adversarial review
dispositions* at the end for what changed and what was deferred by layer.

## Problem & context

NIP-34 has no assignee concept. PRana's core failure mode is two contributors — each
burning their own subscription quota — fixing the *same* issue. A claim is an
**advisory, self-asserted, TTL'd** Nostr event ("I'm on this") others can see before
they start. We can't *prevent* a second claim (Nostr has no global mutex); the
directory's job is to make claims visible, pick a canonical holder, and **surface
contention** so the next contributor is routed elsewhere — the same discipline as
`ambiguousTimestamp` in the status resolver.

This spec covers ONLY the correctness core: a pure fold that collapses an issue's claim
events into one `ClaimState`. Fetch, publish, UI, and CVM are separate later slices.

## Decisions locked in brainstorming

1. **Scope = pure fold only.** `src/claimResolver.ts` + `test/claimResolver.test.ts`,
   mirroring `statusResolver.ts`. No I/O.
2. **Contention = first-come + surface.** With 2+ active claims, `holder` = the earliest
   active claim by `created_at` (tie-break by event id); `contended = true`.

## Security & trust model

The fold **trusts `event.pubkey`** and **trusts `expiration`** — both are guaranteed by
the layer upstream, not by the fold. This mirrors the existing boundary: the fetch gate
verifies signatures (so the fold can trust `pubkey`) and, for claims, the fetch gate also
rejects abusive TTLs (so the fold can trust `expiration` — see *Out of scope*, I2). The
fold stays pure and I/O-free, and reads no clock — `now` is **injected** (deterministic,
like keeping `Date.now()` out of the status resolver).

Claims are **self-asserted**: anyone can claim any issue. Verification only guarantees a
claim is attributable to a real pubkey (it can't be forged onto someone else's identity,
and — because each pubkey's claims are folded independently — one party cannot *release*
another's claim). What self-assertion does NOT prevent: manufacturing contention, or
back-dating `created_at`. Those are advisory-by-nature and handled at the directory layer
(see I3); the fold's job is to report state faithfully, not to adjudicate motive.

## Event shape (the parts the fold reads)

Claim = **addressable** kind `31621` (PROVISIONAL — must be reserved before cross-client
use; see `docs/claim-primitive.md`). The fold reads:

- `pubkey` — the claimant.
- `created_at` — for ordering and replaceability.
- tag `["d", "<issueId>"]` — the addressable replaceability key (authoritative target).
- tag `["e", "<issueId>", "", "root"]` — which issue (MUST equal `d`; see step 1).
- tag `["expiration", "<unix>"]` — NIP-40 TTL.
- tag `["status", "claimed" | "released"]` — lifecycle.

## Types (`src/types.ts`)

Add the provisional kind to the existing `KIND` map:

```ts
CLAIM: 31621, // PROVISIONAL addressable claim over a 1621 issue; reserve before cross-client use
```

New output type, parallel to `ResolvedIssue`:

```ts
export interface ClaimState {
  issueId: string;
  holder: string | null;    // canonical claimant pubkey, or null if unclaimed
  expiresAt: number | null; // holder's expiration (unix seconds), null if unclaimed
  contended: boolean;       // 2+ active claims from different pubkeys
  active: NostrEvent[];     // each active claimant's CURRENT claim, sorted (created_at asc, id asc)
}
```

## The fold — `resolveClaim`

```ts
resolveClaim(issueId: string, claimEvents: NostrEvent[], now: number): ClaimState
```

1. **Filter & target.** Keep kind-`31621` events whose target issue id `=== issueId`.
   A claim is addressable on its `d` tag, so **`d` is the replaceability key and the
   authoritative target**. `claimTargetIssueId(claim)` returns the `d` value, and
   **requires the `e`-root tag (when present) to equal `d`** — a claim whose `e`-root
   `≠ d` is malformed (it would occupy a different relay-side claim-slot than the issue
   it points at) and is **excluded**. Missing `d` ⇒ excluded.
2. **Group by claimant pubkey**; keep the *current* claim per pubkey = the one with the
   greatest `created_at`. On an **equal-`created_at` tie within a pubkey, a `released`
   event beats a `claimed` one** (fail-safe toward *unclaimed*: a falsely-free issue
   costs only a redundant second claim, a falsely-held one parks the item); break any
   remaining tie by **lowest** event id. (`created_at` is attacker-controllable and an
   agent may claim+release within one second, so this tie must not be a silent id
   coin-flip — cf. `ambiguousTimestamp`.) Addressable replaceability ⇒ one current claim
   per claimant.
3. **Active test** on each current claim — ACTIVE iff *all* hold:
   - `claimStatus(claim) === "claimed"` (the `status` tag, defaulting to `"claimed"` when
     absent — a bare claim event is a claim; `"released"` must be explicit), AND
   - `claimExpiration(claim)` parses to a finite number (missing/non-numeric ⇒ NOT
     active — a PRana claim *requires* a TTL), AND
   - `now < expiration`. (The fold trusts `expiration` is within `MAX_TTL` because the
     fetch gate rejected over-long ones; see I2.)
4. **Collapse** the active set; in every branch `active` is sorted `(created_at asc,
   id asc)`:
   - **0** → `{ holder: null, expiresAt: null, contended: false, active: [] }`
   - **1** → `{ holder: pubkey, expiresAt: expiration, contended: false, active: [claim] }`
   - **2+** → `holder` = first by `(created_at asc, id asc)` (first-come); `expiresAt` =
     holder's expiration; `contended: true`; `active` = all active claims.
5. Return `ClaimState { issueId, holder, expiresAt, contended, active }`.

Determinism: every ordering is `(created_at, id)`; `now` is injected. **Note the two
sort *directions* are intentionally opposite** — step 2 takes each pubkey's *newest*
claim (replaceability), step 4 takes the *earliest* rival (first-come). Comment both at
the sort sites so a future reader doesn't "fix" one to match the other.

### Parsing helpers (pure)

In `src/claimResolver.ts` (reuse `tagVals` from `src/nip34.ts`):

- `claimTargetIssueId(claim): string | null` — returns the `d` tag value; if an `e`-root
  tag is present and `≠ d`, or `d` is absent, returns `null` (malformed → excluded).
- `claimStatus(claim): string` — `tagVals(claim, "status")[0] ?? "claimed"`.
- `claimExpiration(claim): number | null` — parse the `expiration` tag; `null` if absent
  or `NaN`.

## Testing (TDD — mirror `test/statusResolver.test.ts`)

Each is a failing-test-first cycle. Extend `test/fixtures.ts` with a `claim(opts)` factory
mirroring the existing `status(opts)` factory (fields: `by`, `issueId`, `expiration`,
`status?`, `at` (created_at), `eventId?`; emits matching `d` and `e`-root tags).

1. no claim events → unclaimed (`holder` null, `contended` false, `active` []).
2. single active claim → claimed; `holder` + `expiresAt` set; `contended` false.
3. `now >= expiration` → unclaimed (expired).
4. `status=released`, unexpired → unclaimed.
5. refresh: same pubkey, later `created_at` + later `expiration` → holder; latest wins;
   earlier ignored.
6. release-after-claim: same pubkey, later `released` event → unclaimed.
7. two different pubkeys, both active → `contended` true; `holder` = earliest by `created_at`.
8. contention tie on `created_at` → deterministic `holder` by lowest event id; `contended` true.
9. missing / non-numeric `expiration` → not active (treated unclaimed).
10. missing `status` tag → treated as claimed (active).
11. a claim targeting issue A does not affect issue B.
12. determinism: reversing the input array does not change the result.
13. **(C1)** same pubkey, a `claimed` and a `released` at the SAME `created_at` →
    unclaimed (released wins the tie, regardless of event-id order — assert both id orders).
14. **(I4)** a claim whose `e`-root `≠ d` is excluded (malformed); a claim with matching
    `d`/`e` on the same issue is honored.
15. **(M5)** boundary: `now === expiration` → unclaimed (guards the `<` vs `<=` off-by-one).

## File structure

| File | Change |
| --- | --- |
| `src/types.ts` | add `KIND.CLAIM = 31621`; add `ClaimState` |
| `src/claimResolver.ts` | new — `resolveClaim` + `claimTargetIssueId` / `claimStatus` / `claimExpiration` |
| `test/fixtures.ts` | add a `claim(opts)` factory (matching `d` + `e`-root) |
| `test/claimResolver.test.ts` | new — the 15 cases above |

`resolveClaim` is single-issue. A batch `resolveClaims(issueIds, claimEvents, now)` (parallel
to `resolveIssues`) is **deferred** until a caller needs it (YAGNI).

## Out of scope / deferred

- **Fetch + verify ingest of claim events** (next slice; mirrors the status fetch path —
  query kind `31621` by `#e` issue id, gate signatures). **REQUIRED gate this slice
  depends on (I2):** the ingest layer MUST reject any claim whose `expiration` exceeds
  `created_at + MAX_TTL` (provisional cap ~14 days — longer than the ~72h publish default,
  but bounded). Without it, a single self-asserted claim with a far-future `expiration`
  parks an issue indefinitely; the fold trusts `expiration` precisely because this gate
  bounds it (the same trust contract as signatures → `pubkey`). The next slice's spec must
  carry this as a tested boundary.
- **Directory-layer policy on contention (I3).** `contended` is **advisory**: the
  directory must **warn, not hide** — a single validly-signed third-party claim must not
  suppress an issue from the worklist, or contention becomes a censorship primitive.
  Present the first-come `holder` as the canonical worker and surface rivals; do not
  route the whole issue away on `contended` alone. **Breadth claim-squatting** (one key
  claiming many issues to drain the worklist) is a directory-layer rate-limit / per-key
  claim-budget / reputation concern — not solvable in the fold.
- **Back-dated `created_at`.** First-come `holder` is spoofable by back-dating `created_at`;
  this is accepted — `holder` is informational and contention is surfaced regardless. The
  `created_at + MAX_TTL` ingest bound (I2) limits how far back-dating can reach before the
  claim reads expired.
- **Claims on already-closed issues** — correctly handled one layer up: the directory
  intersects `ClaimState` with the status fold ("open AND unclaimed"); a claim on a closed
  issue is simply ignored there. Not the fold's concern.
- Publish path / claim-event builder; CVM tools; UI.
- Maintainer override of a claim (v2).
- Reserving the `31621` kind number (external — NIPs repo).
- The TTL *default* value, and the `MAX_TTL` *cap* value (publish-/gate-side; provisional
  ~72h default and ~14d cap, pin later).

## Adversarial review dispositions (2026-06-17)

A red-team pass attacked this design before implementation. Dispositions:

- **Fixed in this fold:** C1 (claim/released same-`created_at` tie → `released` wins,
  fail-safe to unclaimed; test 13); I4 (`d`-authoritative targeting, require `e`-root
  `== d`, exclude mismatches; test 14); M5 (`now === expiration` boundary; test 15); M7
  (`active` sorted in all branches); M6 (comment the two opposite sort directions).
- **Reassigned to the fetch gate (next slice), documented above:** I2 (uncapped
  attacker-controlled `expiration`) — an ingest-admissibility policy, parallel to
  signature-dropping, not pure-fold logic.
- **Reassigned to the directory layer, documented above:** I3 (manufactured contention
  must warn-not-hide; breadth squatting needs rate-limiting); M8 (closed-issue claims).
- **Accepted as a known limitation:** back-datable first-come `holder` (advisory).
