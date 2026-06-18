# Claim Fetch-Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure `resolveClaimsFromEvents` that verifies claim signatures, drops abusive/malformed claims at an admissibility gate (the I2 TTL bound), and folds the rest into per-issue `ClaimState`.

**Architecture:** One new module `src/claimFetch.ts` mirroring `resolveFromEvents`. It reuses `verifyAll` (signature gate) and `resolveClaim` (the fold) and adds `isAdmissibleClaim` — a now-dependent gate: kind 31621, a 1–15 digit `expiration`, `created_at ≤ now + CLOCK_SKEW`, and `expiration ≤ now + MAX_TTL` (the park-from-now bound). Built test-first in 4 clauses.

**Tech Stack:** TypeScript (ESM, `strict`), vitest. No new dependencies. Spec: `docs/superpowers/specs/2026-06-17-claim-fetch-gate-design.md`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/claimFetch.ts` | claim ingest gate + assembly | new — `MAX_TTL_SECONDS`, `CLOCK_SKEW_SECONDS`, `ClaimFetchResult`, `isAdmissibleClaim`, `resolveClaimsFromEvents` |
| `test/fixtures.ts` | synthetic event factories | widen `claim(opts)`'s `expiration?` to `number \| string` |
| `test/claimFetch.test.ts` | the gate + assembly behavior | new — 11 cases across the 4 tasks |

Imports in `claimFetch.ts`: `verifyAll`, `RawEvent`, `Verifier` from `./fetch`; `resolveClaim` from `./claimResolver`; `NostrEvent`, `ClaimState`, `KIND` from `./types`; `tagVals` from `./nip34`. **No `claimResolver.ts` changes** — the gate owns format/TTL admissibility; the fold trusts.

The assembly `resolveClaimsFromEvents` is written once (Task 1) and is stable; only `isAdmissibleClaim`'s body grows clause-by-clause across Tasks 1–4.

---

## Task 1: Ingest assembly + signature gate (kind-only admissibility)

**Files:**
- Create: `src/claimFetch.ts`
- Create: `test/claimFetch.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/claimFetch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveClaimsFromEvents, MAX_TTL_SECONDS, CLOCK_SKEW_SECONDS } from "../src/claimFetch";
import { RawEvent, Verifier } from "../src/fetch";
import { NostrEvent } from "../src/types";
import { claim, CLAIMER_A, CLAIMER_B } from "./fixtures";

const NOW = 1_700_000_000;
const fakeVerify: Verifier = (e) => (e as RawEvent).sig === "good";
const sign = (e: NostrEvent): RawEvent => ({ ...e, sig: "good" });
const forge = (e: NostrEvent): RawEvent => ({ ...e, sig: "bad" });

describe("resolveClaimsFromEvents — sig gate + assembly", () => {
  it("a well-signed, in-horizon claim is admitted; its issue is claimed", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.claims[0].holder).toBe(CLAIMER_A);
    expect(r.stats.droppedSig).toBe(0);
    expect(r.stats.droppedInadmissible).toBe(0);
    expect(r.stats.admitted).toBe(1);
  });

  it("SECURITY: a forged-sig claim is dropped before the fold; issue unclaimed", () => {
    const c = forge(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedSig).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("a released claim is admitted (not dropped) but the issue is unclaimed", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "released" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.admitted).toBe(1);
    expect(r.stats.droppedInadmissible).toBe(0);
    expect(r.claims[0].holder).toBeNull();
  });

  it("batch: claims are routed to the right issue", () => {
    const a = sign(claim({ by: CLAIMER_A, issueId: "issA", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const b = sign(claim({ by: CLAIMER_B, issueId: "issB", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([a, b], ["issA", "issB"], NOW, { verify: fakeVerify });
    expect(r.claims[0].holder).toBe(CLAIMER_A);
    expect(r.claims[1].holder).toBe(CLAIMER_B);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claimFetch.test.ts`
Expected: FAIL — `../src/claimFetch` does not exist yet.

- [ ] **Step 3: Write the module (kind-only admissibility)**

Create `src/claimFetch.ts`:

```typescript
import { NostrEvent, ClaimState, KIND } from "./types";
import { tagVals } from "./nip34";
import { resolveClaim } from "./claimResolver";
import { verifyAll, RawEvent, Verifier } from "./fetch";

/**
 * Claim ingest gate + assembly. Two gates in front of the fold, both here: the
 * signature gate (reused verifyAll) lets the fold trust `pubkey`; the admissibility
 * gate (isAdmissibleClaim) lets it trust `expiration`. now-dependent by necessity —
 * parking is a now-relative threat. See docs/superpowers/specs/2026-06-17-claim-fetch-gate-design.md.
 */

export const MAX_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days; max a claim may hold from now
export const CLOCK_SKEW_SECONDS = 300; // 5 min tolerance for honest clock drift

export interface ClaimFetchResult {
  claims: ClaimState[];
  stats: {
    claimsFetched: number;
    droppedSig: number;
    droppedInadmissible: number;
    admitted: number;
  };
}

/** The admissibility gate. (Built clause-by-clause across the plan; kind only here.) */
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  return claim.kind === KIND.CLAIM;
}

export function resolveClaimsFromEvents(
  rawClaims: RawEvent[],
  issueIds: string[],
  now: number,
  opts: { verify?: Verifier; maxTtl?: number } = {},
): ClaimFetchResult {
  const maxTtl = opts.maxTtl ?? MAX_TTL_SECONDS;
  const verified = verifyAll(rawClaims, opts.verify);
  const admitted = verified.valid.filter((c) => isAdmissibleClaim(c, now, maxTtl));
  const claims = issueIds.map((id) => resolveClaim(id, admitted, now));
  return {
    claims,
    stats: {
      claimsFetched: rawClaims.length,
      droppedSig: verified.dropped,
      droppedInadmissible: verified.valid.length - admitted.length,
      admitted: admitted.length,
    },
  };
}
```

(`now`/`maxTtl` are unused in `isAdmissibleClaim` this task — that is fine; `tsconfig` has no `noUnusedParameters`. The signature is stable so later tasks only grow the body.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; the 4 Task-1 tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/claimFetch.ts test/claimFetch.test.ts
git commit -m "feat(claim): claim ingest assembly + sig gate (resolveClaimsFromEvents)"
```

---

## Task 2: Expiration format gate (integer, length-bounded)

**Files:**
- Modify: `test/fixtures.ts`
- Modify: `src/claimFetch.ts:isAdmissibleClaim`
- Modify: `test/claimFetch.test.ts`

- [ ] **Step 1: Widen the fixture so malformed expirations are constructible**

In `test/fixtures.ts`, change the `claim(opts)` factory's `expiration?: number` field to `expiration?: number | string`. The body already calls `String(opts.expiration)`, which handles both — only the type annotation changes:

```typescript
export function claim(opts: {
  by: string;
  issueId: string;
  at: number; // created_at
  expiration?: number | string;
  status?: string; // "claimed" | "released"; omitted => no status tag
  eventId?: string;
  eRoot?: string; // override the e-root tag value (defaults to issueId); for malformed tests
}): NostrEvent {
```

- [ ] **Step 2: Write the failing tests**

Append to `test/claimFetch.test.ts`:

```typescript
describe("resolveClaimsFromEvents — expiration format gate", () => {
  it("a non-integer or oversized expiration is dropped (inadmissible)", () => {
    const hex = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: "0x10", status: "claimed" }));
    const r1 = resolveClaimsFromEvents([hex], ["iss1"], NOW, { verify: fakeVerify });
    expect(r1.stats.droppedInadmissible).toBe(1);
    expect(r1.claims[0].holder).toBeNull();

    const oversized = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: "1234567890123456", status: "claimed" })); // 16 digits
    expect(resolveClaimsFromEvents([oversized], ["iss1"], NOW, { verify: fakeVerify }).stats.droppedInadmissible).toBe(1);
  });

  it("a claim with no expiration tag is dropped (inadmissible)", () => {
    const noExp = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, status: "claimed" }));
    const r = resolveClaimsFromEvents([noExp], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/claimFetch.test.ts -t "format"`
Expected: FAIL — with kind-only admissibility, `"0x10"` (→`Number`=16) and the missing-expiration claim are admitted (`droppedInadmissible` is 0), and the 16-digit claim is even reported `claimed`.

- [ ] **Step 4: Add the format clause to `isAdmissibleClaim`**

In `src/claimFetch.ts`, replace `isAdmissibleClaim`'s body:

```typescript
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  if (claim.kind !== KIND.CLAIM) return false;
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return false; // integer, length-bounded
  return true;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; Task 1 + Task 2 tests pass (Task 1's claims use 10-digit integer expirations, which still match `/^\d{1,15}$/`).

- [ ] **Step 6: Commit**

```bash
git add test/fixtures.ts src/claimFetch.ts test/claimFetch.test.ts
git commit -m "feat(claim): expiration format gate (integer, length-bounded)"
```

---

## Task 3: Park horizon — reject expiration beyond `now + MAX_TTL`

**Files:**
- Modify: `src/claimFetch.ts:isAdmissibleClaim`
- Modify: `test/claimFetch.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/claimFetch.test.ts`:

```typescript
describe("resolveClaimsFromEvents — park horizon (E <= now + MAX_TTL)", () => {
  it("I2: a far-future expiration (the future-dated parking attack) is dropped", () => {
    const yr = 365 * 24 * 3600;
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + yr, expiration: NOW + yr + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("boundary: E = now + MAX_TTL is admitted; +1 is dropped", () => {
    const ok = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS, status: "claimed" }));
    expect(resolveClaimsFromEvents([ok], ["iss1"], NOW, { verify: fakeVerify }).claims[0].holder).toBe(CLAIMER_A);

    const over = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS + 1, status: "claimed" }));
    const r = resolveClaimsFromEvents([over], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("opts.maxTtl override drops a claim beyond the injected cap", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify, maxTtl: 500 }); // 1000 > 500
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("stats: claimsFetched === droppedSig + droppedInadmissible + admitted", () => {
    const good = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const forged = forge(claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const overTtl = sign(claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS + 1, status: "claimed" }));
    const r = resolveClaimsFromEvents([good, forged, overTtl], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats).toEqual({ claimsFetched: 3, droppedSig: 1, droppedInadmissible: 1, admitted: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claimFetch.test.ts -t "horizon"`
Expected: FAIL — with no horizon clause, a far-future or over-`maxTtl` expiration passes the format check and is admitted (reported `claimed`), so the drop counts are wrong.

- [ ] **Step 3: Add the horizon clause to `isAdmissibleClaim`**

In `src/claimFetch.ts`, replace the trailing `return true;` with the now-relative bound:

```typescript
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  if (claim.kind !== KIND.CLAIM) return false;
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return false; // integer, length-bounded
  return Number(raw) <= now + maxTtl; // park horizon, measured from NOW
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; all Task 1–3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claimFetch.ts test/claimFetch.test.ts
git commit -m "feat(claim): park horizon — reject expiration beyond now + MAX_TTL"
```

---

## Task 4: Future-date guard — reject `created_at > now + CLOCK_SKEW`

**Files:**
- Modify: `src/claimFetch.ts:isAdmissibleClaim`
- Modify: `test/claimFetch.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/claimFetch.test.ts`:

```typescript
describe("resolveClaimsFromEvents — future-date guard (created_at <= now + CLOCK_SKEW)", () => {
  it("created_at within skew is admitted; beyond skew is dropped (even with a valid expiration)", () => {
    const within = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + CLOCK_SKEW_SECONDS, expiration: NOW + 1000, status: "claimed" }));
    expect(resolveClaimsFromEvents([within], ["iss1"], NOW, { verify: fakeVerify }).claims[0].holder).toBe(CLAIMER_A);

    const beyond = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + CLOCK_SKEW_SECONDS + 1, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([beyond], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/claimFetch.test.ts -t "future-date"`
Expected: FAIL — without the guard, the `beyond` claim (created_at just past skew, but a near-now valid expiration) passes the horizon and is admitted (reported `claimed`), so `droppedInadmissible` is 0 and `holder` is set.

- [ ] **Step 3: Add the future-date clause to `isAdmissibleClaim`**

In `src/claimFetch.ts`, add the `created_at` guard before the horizon return:

```typescript
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  if (claim.kind !== KIND.CLAIM) return false;
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return false; // integer, length-bounded
  if (claim.created_at > now + CLOCK_SKEW_SECONDS) return false; // no future-dating
  return Number(raw) <= now + maxTtl; // park horizon, measured from NOW
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; the full suite passes (all prior tests + the claim fetch-gate).

- [ ] **Step 5: Commit**

```bash
git add src/claimFetch.ts test/claimFetch.test.ts
git commit -m "feat(claim): reject future-dated created_at (clock-skew bound)"
```

---

## Self-Review

- **Spec coverage:** `MAX_TTL_SECONDS`/`CLOCK_SKEW_SECONDS`/`ClaimFetchResult`/`resolveClaimsFromEvents` (Task 1) ✅; sig gate via `verifyAll` (Task 1) ✅; the four admissibility clauses — kind (T1), format `/^\d{1,15}$/` (T2), horizon `E ≤ now+maxTtl` (T3), future-date `created_at ≤ now+skew` (T4) ✅; `admitted` in stats (T1) ✅; the 11 spec tests map to Tasks 1–4 (4+2+4+1=11) ✅. Out-of-scope items (live query, directory intersection, publish, finer wrong-kind stat) are absent.
- **Placeholder scan:** no TBD/"handle edge cases"/uncoded steps; every code step shows complete code.
- **Type consistency:** `isAdmissibleClaim(claim, now, maxTtl)` and `resolveClaimsFromEvents(rawClaims, issueIds, now, opts)` signatures are stable across all tasks; `ClaimFetchResult.stats` (4 fields) is used identically in the impl and the stats test; the `claim(opts)` fixture fields match every call site (`expiration` widened to `number | string` in T2 before the first string use).
- **Increment integrity:** each task's tests fail against the prior task's code for the stated reason — T2 format vs kind-only (`"0x10"`→16 admitted; missing admitted); T3 horizon vs format-only (far-future/over-`maxTtl` admitted); T4 guard vs no-guard (future-dated `created_at` with near-now `E` admitted). Genuine red→green. `now`/`maxTtl` unused in T1's `isAdmissibleClaim` is clean under `tsconfig` (no `noUnusedParameters`).
