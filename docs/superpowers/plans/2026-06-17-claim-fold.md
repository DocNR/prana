# Claim Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure, deterministic `resolveClaim(issueId, claimEvents, now)` fold that collapses an issue's NIP-34-style claim events (kind `31621`) into one `ClaimState`, mirroring the status resolver.

**Architecture:** One new pure module `src/claimResolver.ts` (no I/O, trusts `event.pubkey`; signature/TTL admissibility is the fetch gate's job in a later slice). It folds claim events: target by the addressable `d` tag (rejecting `e`-root≠`d`), keep each pubkey's current claim (latest `created_at`; on a tie `released` beats `claimed`), an active claim is `status=claimed` AND unexpired (`now < expiration`), then collapse — 0 → unclaimed, 1 → claimed, 2+ → contended with the first-come (earliest) holder. Built test-first in 5 increments.

**Tech Stack:** TypeScript (ESM, `strict`), vitest. No new dependencies. Spec: `docs/superpowers/specs/2026-06-17-claim-fold-design.md`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/types.ts` | shared event/result shapes | add `KIND.CLAIM = 31621`; add `ClaimState` |
| `src/claimResolver.ts` | the pure claim fold (single source of truth for claim logic) | new — `resolveClaim` + `claimTargetIssueId` / `claimStatus` / `claimExpiration` |
| `test/fixtures.ts` | synthetic event factories | add `claim(opts)` factory + `CLAIMER_A` / `CLAIMER_B` |
| `test/claimResolver.test.ts` | the fold's behavior | new — 15 cases across the 5 tasks |

`resolveClaim` is single-issue; a batch `resolveClaims` is deferred (YAGNI). Helpers `claimStatus`/`claimExpiration` stay module-private; `claimTargetIssueId` is exported (the later fetch slice will reuse it), mirroring `statusTargetIssueId`.

---

## Task 1: Scaffold — types, fixture, targeting, single-claim collapse

**Files:**
- Modify: `src/types.ts`
- Create: `src/claimResolver.ts`
- Modify: `test/fixtures.ts`
- Create: `test/claimResolver.test.ts`

- [ ] **Step 1: Add the claim fixture factory and claimant constants**

In `test/fixtures.ts`, after the `RANDO` export (around line 13), add:

```typescript
export const CLAIMER_A = "npub_claimer_a";
export const CLAIMER_B = "npub_claimer_b";
```

Then append this factory to the end of the file:

```typescript
export function claim(opts: {
  by: string;
  issueId: string;
  at: number; // created_at
  expiration?: number;
  status?: string; // "claimed" | "released"; omitted => no status tag
  eventId?: string;
  eRoot?: string; // override the e-root tag value (defaults to issueId); for malformed tests
}): NostrEvent {
  const eRoot = opts.eRoot ?? opts.issueId;
  return {
    id: opts.eventId ?? id("claim"),
    pubkey: opts.by,
    created_at: opts.at,
    kind: KIND.CLAIM,
    tags: [
      ["d", opts.issueId],
      ["e", eRoot, "", "root"],
      ...(opts.expiration !== undefined ? [["expiration", String(opts.expiration)]] : []),
      ...(opts.status !== undefined ? [["status", opts.status]] : []),
    ],
    content: "",
  };
}
```

- [ ] **Step 2: Write the failing tests (Task 1 set)**

Create `test/claimResolver.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveClaim } from "../src/claimResolver";
import { claim, CLAIMER_A, CLAIMER_B } from "./fixtures";

const NOW = 1_700_000_000;
const SOON = 1_700_000_100; // > NOW
const PAST = 1_699_999_900; // < NOW

describe("resolveClaim — basics (target, status, single-claim collapse)", () => {
  it("no claim events => unclaimed", () => {
    const r = resolveClaim("iss1", [], NOW);
    expect(r.holder).toBeNull();
    expect(r.expiresAt).toBeNull();
    expect(r.contended).toBe(false);
    expect(r.active).toEqual([]);
  });

  it("a single active claim => claimed by that pubkey", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const r = resolveClaim("iss1", [c], NOW);
    expect(r.holder).toBe(CLAIMER_A);
    expect(r.expiresAt).toBe(SOON);
    expect(r.contended).toBe(false);
    expect(r.active).toHaveLength(1);
  });

  it("a released claim is not active => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "released" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("a claim with no status tag is treated as claimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON });
    expect(resolveClaim("iss1", [c], NOW).holder).toBe(CLAIMER_A);
  });

  it("a claim targeting issue A does not affect issue B", () => {
    const c = claim({ by: CLAIMER_A, issueId: "issA", at: NOW, expiration: SOON, status: "claimed" });
    expect(resolveClaim("issB", [c], NOW).holder).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/claimResolver.test.ts`
Expected: FAIL — `resolveClaim` (and `KIND.CLAIM`) don't exist yet.

- [ ] **Step 4: Add the types**

In `src/types.ts`, add `CLAIM` to the `KIND` map (after `STATUS_DRAFT`):

```typescript
  STATUS_DRAFT: 1633,
  CLAIM: 31621, // PROVISIONAL addressable claim over a 1621 issue; reserve before cross-client use
```

Then add the output type after `ResolvedIssue`:

```typescript
export interface ClaimState {
  issueId: string;
  holder: string | null;    // canonical claimant pubkey, or null if unclaimed
  expiresAt: number | null; // holder's expiration (unix seconds), null if unclaimed
  contended: boolean;       // 2+ active claims from different pubkeys
  active: NostrEvent[];     // each active claimant's current claim, sorted (created_at asc, id asc)
}
```

- [ ] **Step 5: Write the minimal implementation**

Create `src/claimResolver.ts`:

```typescript
import { NostrEvent, ClaimState, KIND } from "./types";
import { tagVals } from "./nip34";

/**
 * Pure claim fold (mirrors statusResolver). Trusts `event.pubkey` and `expiration`;
 * signature + TTL admissibility are the fetch gate's job. `now` is injected so the
 * fold stays deterministic and clock-free. See docs/superpowers/specs/2026-06-17-claim-fold-design.md.
 */

/** The issue a claim targets: the addressable `d` tag. (e-root validation added later.) */
export function claimTargetIssueId(claim: NostrEvent): string | null {
  return tagVals(claim, "d")[0] ?? null;
}

/** Lifecycle status; a bare claim event (no status tag) is a claim. */
function claimStatus(claim: NostrEvent): string {
  return tagVals(claim, "status")[0] ?? "claimed";
}

/** NIP-40 expiration as a number, or null if absent/non-numeric. */
function claimExpiration(claim: NostrEvent): number | null {
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function resolveClaim(issueId: string, claimEvents: NostrEvent[], now: number): ClaimState {
  const active = claimEvents.filter(
    (c) =>
      c.kind === KIND.CLAIM &&
      claimTargetIssueId(c) === issueId &&
      claimStatus(c) === "claimed",
  );
  if (active.length === 0) {
    return { issueId, holder: null, expiresAt: null, contended: false, active: [] };
  }
  const holder = active[0];
  return {
    issueId,
    holder: holder.pubkey,
    expiresAt: claimExpiration(holder),
    contended: active.length > 1,
    active,
  };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/claimResolver.test.ts`
Expected: tsc exit 0; the 5 Task-1 tests pass (full suite still green).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/claimResolver.ts test/fixtures.ts test/claimResolver.test.ts
git commit -m "feat(claim): claim fold scaffold — targeting, status, single-claim collapse"
```

---

## Task 2: Expiry — the TTL dimension of "active"

**Files:**
- Modify: `src/claimResolver.ts:resolveClaim`
- Modify: `test/claimResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/claimResolver.test.ts`:

```typescript
describe("resolveClaim — expiry / TTL", () => {
  it("an expired claim (now >= expiration) => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: PAST, expiration: PAST, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("a claim with no expiration is not active => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("boundary: now === expiration => unclaimed (strict <)", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: PAST, expiration: NOW, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claimResolver.test.ts -t "expiry"`
Expected: FAIL — Task 1's active filter ignores `expiration`, so these claims are wrongly active (`holder` is `CLAIMER_A`, not null).

- [ ] **Step 3: Add the expiration check to the active filter**

In `src/claimResolver.ts`, replace the `active` filter in `resolveClaim` with one that also requires an unexpired expiration:

```typescript
  const active = claimEvents.filter((c) => {
    if (c.kind !== KIND.CLAIM || claimTargetIssueId(c) !== issueId) return false;
    if (claimStatus(c) !== "claimed") return false;
    const exp = claimExpiration(c);
    return exp !== null && now < exp;
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/claimResolver.test.ts`
Expected: all Task 1 + Task 2 tests pass (Task 1's active claims carry a future `expiration`, so they remain active).

- [ ] **Step 5: Commit**

```bash
git add src/claimResolver.ts test/claimResolver.test.ts
git commit -m "feat(claim): expiry/TTL in the active test"
```

---

## Task 3: Per-pubkey replaceability (released wins a same-timestamp tie)

**Files:**
- Modify: `src/claimResolver.ts`
- Modify: `test/claimResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/claimResolver.test.ts`:

```typescript
describe("resolveClaim — per-pubkey replaceability", () => {
  it("refresh: the same pubkey's latest claim wins (not contention)", () => {
    const older = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const newer = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + 10, expiration: SOON + 50, status: "claimed" });
    const r = resolveClaim("iss1", [older, newer], NOW);
    expect(r.holder).toBe(CLAIMER_A);
    expect(r.contended).toBe(false);
    expect(r.expiresAt).toBe(SOON + 50); // the newer expiration
  });

  it("release after claim: a later released event frees the issue", () => {
    const claimed = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const released = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + 10, expiration: SOON, status: "released" });
    expect(resolveClaim("iss1", [claimed, released], NOW).holder).toBeNull();
  });

  it("a claimed and a released at the SAME created_at => released wins (fail-safe), either id order", () => {
    const mk = (claimedId: string, releasedId: string) => [
      claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: claimedId }),
      claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "released", eventId: releasedId }),
    ];
    expect(resolveClaim("iss1", mk("aaaa", "zzzz"), NOW).holder).toBeNull();
    expect(resolveClaim("iss1", mk("zzzz", "aaaa"), NOW).holder).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claimResolver.test.ts -t "replaceability"`
Expected: FAIL — without per-pubkey grouping, the refresh test sees two active claims (`contended` wrongly true), and the same-timestamp test can keep the `claimed` one.

- [ ] **Step 3: Add per-pubkey current-claim selection**

In `src/claimResolver.ts`, add these two helpers above `resolveClaim`:

```typescript
/** Is claim `a` more "current" than `b` for the same pubkey? Latest created_at;
 *  on a tie, a `released` beats a `claimed` (fail-safe toward unclaimed); then lowest id. */
function isMoreCurrent(a: NostrEvent, b: NostrEvent): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  const aReleased = claimStatus(a) === "released";
  const bReleased = claimStatus(b) === "released";
  if (aReleased !== bReleased) return aReleased; // released supersedes claimed at equal time
  return a.id < b.id; // same status class: deterministic by lowest id
}

/** One current claim per claimant pubkey (addressable replaceability). */
function currentClaimPerPubkey(claims: NostrEvent[]): NostrEvent[] {
  const byPubkey = new Map<string, NostrEvent>();
  for (const c of claims) {
    const prev = byPubkey.get(c.pubkey);
    if (!prev || isMoreCurrent(c, prev)) byPubkey.set(c.pubkey, c);
  }
  return [...byPubkey.values()];
}
```

Then change `resolveClaim` to fold over each pubkey's current claim instead of all claims. Replace the body's `active` computation:

```typescript
  const mine = claimEvents.filter(
    (c) => c.kind === KIND.CLAIM && claimTargetIssueId(c) === issueId,
  );
  const active = currentClaimPerPubkey(mine).filter((c) => {
    if (claimStatus(c) !== "claimed") return false;
    const exp = claimExpiration(c);
    return exp !== null && now < exp;
  });
```

(The rest of `resolveClaim` — the `active.length === 0` branch and the holder/contended return — is unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/claimResolver.test.ts`
Expected: tsc exit 0; all Task 1–3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claimResolver.ts test/claimResolver.test.ts
git commit -m "feat(claim): per-pubkey replaceability (released wins same-timestamp tie)"
```

---

## Task 4: Contention — first-come holder, deterministic

**Files:**
- Modify: `src/claimResolver.ts:resolveClaim`
- Modify: `test/claimResolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/claimResolver.test.ts`:

```typescript
describe("resolveClaim — contention (first-come + surface)", () => {
  it("two pubkeys both active => contended, holder = earliest by created_at", () => {
    const first = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const second = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW + 10, expiration: SOON, status: "claimed" });
    // pass second-first to defeat an input-order-dependent holder pick
    const r = resolveClaim("iss1", [second, first], NOW);
    expect(r.contended).toBe(true);
    expect(r.holder).toBe(CLAIMER_A); // earliest created_at
    expect(r.active).toHaveLength(2);
  });

  it("contention tie on created_at => deterministic holder by lowest event id", () => {
    const a = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "zzzz" });
    const b = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "aaaa" });
    const r = resolveClaim("iss1", [a, b], NOW);
    expect(r.contended).toBe(true);
    expect(r.holder).toBe(CLAIMER_B); // lowest id "aaaa"
  });

  it("determinism: reversing the input array does not change the result", () => {
    const a = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "id-a" });
    const b = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW + 5, expiration: SOON, status: "claimed", eventId: "id-b" });
    const r1 = resolveClaim("iss1", [a, b], NOW);
    const r2 = resolveClaim("iss1", [b, a], NOW);
    expect(r1.holder).toBe(r2.holder);
    expect(r1.active.map((c) => c.id)).toEqual(r2.active.map((c) => c.id));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/claimResolver.test.ts -t "contention"`
Expected: FAIL — `active` is unsorted, so `holder = active[0]` depends on input order (the first test gets `CLAIMER_B`, and the determinism test's `active` ids differ between runs).

- [ ] **Step 3: Sort the active set (first-come) before collapsing**

In `src/claimResolver.ts`, sort `active` by `(created_at asc, id asc)` so the holder is the earliest and the output is order-independent in all branches. Replace the `active` assignment's tail and the return so the sort is applied:

```typescript
  const active = currentClaimPerPubkey(mine)
    .filter((c) => {
      if (claimStatus(c) !== "claimed") return false;
      const exp = claimExpiration(c);
      return exp !== null && now < exp;
    })
    // first-come: earliest created_at is the canonical holder; id breaks ties.
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
```

(`holder = active[0]` and `contended: active.length > 1` already do the right thing once `active` is sorted.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run test/claimResolver.test.ts`
Expected: tsc exit 0; all Task 1–4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/claimResolver.ts test/claimResolver.test.ts
git commit -m "feat(claim): contention — first-come holder, deterministic"
```

---

## Task 5: Reject malformed `e`-root ≠ `d` targeting

**Files:**
- Modify: `src/claimResolver.ts:claimTargetIssueId`
- Modify: `test/claimResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/claimResolver.test.ts`:

```typescript
describe("resolveClaim — malformed targeting (e-root must equal d)", () => {
  it("a claim whose e-root != d is excluded; a matching one is honored", () => {
    const malformed = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eRoot: "other-issue" });
    expect(resolveClaim("iss1", [malformed], NOW).holder).toBeNull();

    const wellFormed = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    expect(resolveClaim("iss1", [wellFormed], NOW).holder).toBe(CLAIMER_B);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/claimResolver.test.ts -t "malformed"`
Expected: FAIL — `claimTargetIssueId` returns the `d` tag (`"iss1"`) regardless of the `e`-root, so the malformed claim is wrongly honored (`holder` is `CLAIMER_A`, not null).

- [ ] **Step 3: Require e-root == d in the targeting helper**

In `src/claimResolver.ts`, replace `claimTargetIssueId` with:

```typescript
/** The issue a claim targets: the addressable `d` tag. `d` is the replaceability
 *  key, so it is authoritative; if an `e`-root tag is also present it MUST equal `d`
 *  (else the claim would occupy a different relay-side slot than the issue it points
 *  at — malformed → excluded). */
export function claimTargetIssueId(claim: NostrEvent): string | null {
  const d = tagVals(claim, "d")[0];
  if (d === undefined) return null;
  const eRoot = claim.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1];
  if (eRoot !== undefined && eRoot !== d) return null; // malformed: e-root != d
  return d;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; the full suite (all prior tests + claim fold) passes.

- [ ] **Step 5: Commit**

```bash
git add src/claimResolver.ts test/claimResolver.test.ts
git commit -m "feat(claim): reject e-root != d malformed targeting"
```

---

## Self-Review

- **Spec coverage:** ClaimState + KIND.CLAIM (Task 1) ✅; targeting via `d` (Task 1) + `e`==`d` requirement (Task 5) ✅; `claimStatus` default-claimed (Task 1) ✅; `claimExpiration` + active test incl. no-expiration→inactive and `now < expiration` (Task 2) ✅; per-pubkey replaceability + released-wins tie / C1 (Task 3) ✅; first-come contention + determinism (Task 4) ✅; the 15 spec tests map to Tasks 1–5 (5+3+3+3+1=15) ✅. Out-of-scope items (fetch/gate I2, directory I3, publish, batch) are correctly absent.
- **Placeholder scan:** no TBD/"handle edge cases"/uncoded steps; every code step shows complete code.
- **Type consistency:** `ClaimState { issueId, holder, expiresAt, contended, active }` is used identically in `types.ts`, the implementation, and every test. `resolveClaim(issueId, claimEvents, now)` and `claimTargetIssueId(claim)` signatures are stable across tasks. `KIND.CLAIM` referenced consistently. The `claim(opts)` fixture's fields (`by`, `issueId`, `at`, `expiration?`, `status?`, `eventId?`, `eRoot?`) match every call site.
- **Increment integrity:** each task's tests fail against the prior task's code for the stated reason (Task 2 expiry vs no-expiry filter; Task 3 grouping vs per-event; Task 4 sort vs unsorted holder; Task 5 e==d vs d-only), then pass — genuine red→green throughout. `now` is unused in Task 1 but `tsconfig` has no `noUnusedParameters`, so typecheck stays clean.
