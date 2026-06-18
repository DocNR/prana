# Claim fetch-gate (ingest admissibility) — design spec

**Status:** approved design, ready for an implementation plan.
**Scope:** the pure claim *ingest assembly* only — one new module mirroring `resolveFromEvents`.
**Builds on:** the merged claim fold (`src/claimResolver.ts`, `resolveClaim`) and its spec
`docs/superpowers/specs/2026-06-17-claim-fold-design.md`. This slice implements that spec's
deferred requirement **I2** (the fetch gate must bound claim TTLs).
**Hardened by** an adversarial design review (2026-06-17) that found the first draft's gate
did NOT stop parking (a future-dated `created_at` slid the window arbitrarily far ahead).
The gate rule below is the corrected, now-relative version — see *Adversarial review
dispositions* at the end.

## Problem & context

The claim fold (`resolveClaim`) trusts `event.pubkey` AND `expiration`, exactly as the
status resolver trusts `pubkey`. Trusting `pubkey` is made safe by the signature gate
(`verifyAll`). Trusting `expiration` is what THIS slice makes safe: a claim is
self-asserted and BOTH its `expiration` and `created_at` are attacker-controllable numbers
in a signed event, so without a bound a single signed claim parks an issue far into the
future (finding **I2**). This module is the ingest gate that rejects abusive and malformed
claims before they reach the fold — the same shape as the signature gate, one layer out.

Pure ingest assembly only: no live relay query (no claims exist on relays yet, and there
is no caller until the directory slice). Live fetch is deferred.

## Decisions locked in brainstorming

1. **Scope = pure ingest assembly.** `src/claimFetch.ts` + `test/claimFetch.test.ts`,
   mirroring `resolveFromEvents`. Reuses `verifyAll` (sig gate) and `resolveClaim` (fold).
2. **`MAX_TTL = 14 days`.** The maximum a claim may hold an issue, measured **from now**.

## Security & trust model

Two gates in front of the fold, both here at ingest:
- **Signature** — reuse `verifyAll` (drops events whose sig is not authentic). Lets the
  fold trust `pubkey`.
- **Admissibility (I2, new)** — drop claims whose `expiration`/`created_at` are malformed
  or abusive. Lets the fold trust `expiration`.

**The admissibility gate is `now`-DEPENDENT, by necessity.** The fold reports an issue
`claimed` while `now < expiration`. "Parking" — holding an issue too far into the future —
is therefore a statement about `now`, not about the claim's self-asserted birth time. So
the bound that defends against parking must be measured **relative to `now`**
(`expiration ≤ now + MAX_TTL`), and `created_at` (also attacker-controlled) must be
constrained to not sit in the future. Bounding `expiration − created_at` — as a first draft
did — is trivially bypassed by future-dating `created_at`, because then the 14-day window
just slides forward. The gate does NOT enforce a *lower* bound / freshness: an admitted
claim may already be expired relative to `now` (the fold marks it inactive). The gate caps
the *upper* horizon; the fold owns the lower edge.

## The admissibility gate

A claim is **admissible** iff ALL hold (with `E = Number(expiration)`, `C = created_at`):
- `kind === KIND.CLAIM` (31621);
- its `expiration` tag value is a **1–15 digit string** — matches `/^\d{1,15}$/` (rejects
  `"abc"`, `"0x10"`, `" 100 "`, `"-5"`, `"1.5"`, `""`, a missing tag, and pathologically
  long digit strings that would force a costly `Number()` parse; 15 digits is far above any
  real unix-second timestamp, which is 10);
- **`C ≤ now + CLOCK_SKEW`** — reject future-dated claims (honest clock drift tolerated by
  `CLOCK_SKEW`); and
- **`E ≤ now + MAX_TTL`** — the park horizon, measured from now.

That rejects, together: non-integer/garbage/oversized expirations, missing expirations,
**future-dated `created_at`** (the C1 bypass), and the **abusive far-future** parking attack
(`E > now + MAX_TTL`). A degenerate claim (`E ≤ C`) needs no special rule — it is admitted
and the fold inactivates it (`now < E` is false).

```ts
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  if (claim.kind !== KIND.CLAIM) return false;
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return false; // integer, length-bounded
  if (claim.created_at > now + CLOCK_SKEW_SECONDS) return false;  // no future-dating
  return Number(raw) <= now + maxTtl;                             // park horizon from NOW
}
```

## Types & constants (`src/claimFetch.ts`)

```ts
export const MAX_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days; max a claim may hold from now
export const CLOCK_SKEW_SECONDS = 300;            // 5 min tolerance for honest clock drift

export interface ClaimFetchResult {
  claims: ClaimState[]; // one per requested issueId, in input order
  stats: {
    claimsFetched: number;       // raw input events
    droppedSig: number;          // failed signature verification
    droppedInadmissible: number; // failed the admissibility gate (format / future-date / TTL / wrong-kind)
    admitted: number;            // reached the fold (claimsFetched - droppedSig - droppedInadmissible)
  };
}
```

`droppedInadmissible` blends format, future-date, over-TTL, and wrong-kind rejections. In
production the live query filters `kinds:[31621]`, so wrong-kind only occurs on a recorded
path; a finer split is deferred (YAGNI). `admitted` is surfaced explicitly so the count of
claims reaching the fold stays reconstructable even if a new drop class is added later.

## The assembly — `resolveClaimsFromEvents`

```ts
resolveClaimsFromEvents(
  rawClaims: RawEvent[],
  issueIds: string[],
  now: number,
  opts?: { verify?: Verifier; maxTtl?: number },
): ClaimFetchResult
```

Pipeline (pure; `verify`, `maxTtl`, `now` all injectable):
1. `verifyAll(rawClaims, opts.verify)` → `{ valid, dropped }` (the signature gate; passing
   `undefined` for `verify` uses the production `defaultVerify` inside `verifyAll`).
2. `admitted = valid.filter((c) => isAdmissibleClaim(c, now, opts.maxTtl ?? MAX_TTL_SECONDS))`.
3. `claims = issueIds.map((id) => resolveClaim(id, admitted, now))` — one `ClaimState` per
   requested issue, routed by the fold's own `claimTargetIssueId`.
4. Return `{ claims, stats: { claimsFetched: rawClaims.length, droppedSig: <verifyAll>.dropped,
   droppedInadmissible: valid.length - admitted.length, admitted: admitted.length } }`.

`CLOCK_SKEW_SECONDS` is a fixed module constant (not injected); `MAX_TTL` is injectable via
`opts.maxTtl` so tests can prove the cap is the parameter, not a hardcode.

## File structure

| File | Change |
| --- | --- |
| `src/claimFetch.ts` | new — `MAX_TTL_SECONDS`, `CLOCK_SKEW_SECONDS`, `ClaimFetchResult`, `isAdmissibleClaim`, `resolveClaimsFromEvents` |
| `test/fixtures.ts` | widen `claim(opts)`'s `expiration?` from `number` to `number \| string` (so malformed-expiration cases are constructible; `String(opts.expiration)` already handles both) |
| `test/claimFetch.test.ts` | new — the cases below |

Imports in `claimFetch.ts`: `verifyAll`, `RawEvent`, `Verifier` from `./fetch`; `resolveClaim`
from `./claimResolver`; `NostrEvent`, `ClaimState`, `KIND` from `./types`; `tagVals` from `./nip34`.
**No changes to `src/claimResolver.ts`** — its lenient `claimExpiration` is fine because in
production only gated claims reach it; the strict format check lives here at the gate.

## Testing (TDD — mirror `test/fetch.test.ts`)

Reuse the fetch-test idiom: a local `fakeVerify = (e) => e.sig === "good"`, `sign`/`forge`
wrappers, and the `claim(opts)` fixture. Use a fixed `NOW` and reference the exported
`MAX_TTL_SECONDS` / `CLOCK_SKEW_SECONDS` in assertions. Cases:

1. a well-signed, in-horizon claim (`created_at = NOW`, `E = NOW + 1000`) → its issue is
   `claimed`; `droppedSig = 0`, `droppedInadmissible = 0`, `admitted = 1`.
2. **SECURITY:** a forged-sig claim → `droppedSig = 1`, issue unclaimed (gate in front of fold).
3. **I2 / C1 — future-dated `created_at`:** `created_at = NOW + 365d`, `E = created_at + 1000`
   → `droppedInadmissible = 1`, issue unclaimed (the parking bypass must be rejected).
4. **park horizon boundary (now-relative):** `E = NOW + MAX_TTL_SECONDS` → admitted (claimed);
   `E = NOW + MAX_TTL_SECONDS + 1` → dropped.
5. **future-date boundary:** `created_at = NOW + CLOCK_SKEW_SECONDS` (with a valid `E`) →
   admitted; `created_at = NOW + CLOCK_SKEW_SECONDS + 1` → dropped.
6. non-integer expiration (`"abc"`, `"0x10"`) and an oversized digit string (16+ digits) →
   dropped (inadmissible).
7. missing expiration tag → dropped (inadmissible).
8. a `status=released` claim that is otherwise admissible → **admitted** (not dropped) and
   the issue is `unclaimed` (the fold inactivates it). Guards against a future "drop
   non-claimed at the gate" optimization that would break release semantics.
9. batch: `resolveClaimsFromEvents([claimForA, claimForB], ["issA", "issB"], NOW)` →
   `claims[0]` holds A's claimant, `claims[1]` holds B's; claims routed to the right issue.
10. `opts.maxTtl` override: a claim within 14 days but exceeding a tiny injected `maxTtl`
    → dropped (proves the cap is the injected value, not hardcoded).
11. stats: a mix of good + forged + over-TTL claims yields the correct
    `claimsFetched` / `droppedSig` / `droppedInadmissible` / `admitted`, and
    `claimsFetched === droppedSig + droppedInadmissible + admitted`.

## Out of scope / deferred

- **Live relay query** (`fetchClaims(issueIds, relays, query)` querying kind `31621` by `#e`)
  — mirrors `fetchRepo`'s status query; deferred until the directory layer has a caller.
- **Directory intersection** "open AND unclaimed" — combining `ClaimState` with the status
  fold, one layer up (and honoring the claim spec's **I3**: contention is advisory).
- **Refresh / breadth squatting** — a determined attacker can re-publish a fresh in-horizon
  claim every `MAX_TTL` to keep parking, or claim many issues from one key. The gate bounds
  a *single* claim's horizon; rate-limit / per-key claim-budget / reputation is a
  directory-layer concern (carried over from the claim spec).
- **Publish path / claim-event builder; CVM tools; UI.**
- **No `claimResolver` changes** — the gate owns format/TTL admissibility; the fold trusts.
- A finer `droppedWrongKind` stat split; reserving the `31621` kind number (external); the
  publish-side TTL *default* (~72h) is unaffected by this gate's `MAX_TTL` *cap*.

## Adversarial review dispositions (2026-06-17)

- **C1/C2 (Critical) — FIXED here:** the first draft bounded `E ≤ created_at + MAX_TTL`
  (now-independent), which a future-dated `created_at` bypasses to park indefinitely. The
  gate is now `now`-dependent: `created_at ≤ now + CLOCK_SKEW` and `E ≤ now + MAX_TTL`.
- **I4 (Important) — FIXED here:** tests now include future-dated-`created_at` rejection
  (test 3), the now-relative horizon boundary (test 4), and the skew boundary (test 5); the
  earlier `created_at + MAX_TTL` boundary is gone.
- **I3 — FIXED here:** `admitted` added to stats; the `droppedInadmissible` blend documented.
- **I1 — FIXED here:** `/^\d{1,15}$/` length-bounds the digit string (no pathological parse);
  the "canonical" overclaim dropped (leading zeros are harmless — they fall to the horizon).
- **M1 — test added** (test 8: released-but-admitted → unclaimed).
- **Deferred (documented above):** refresh/breadth squatting (directory layer); finer
  wrong-kind stat split (YAGNI).
