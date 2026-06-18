# EUC-Group Cross-Fork Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a sibling fork owner's resolve/close as a non-authoritative `forkSignal` on each issue, fixing the finding #2 × #4 false-open without letting forks change canonical status.

**Architecture:** The resolver stays pure and canonical — `pickWinner` and `state`/`decidedBy` are untouched. A parallel `pickForkSignal` computes, from the *same* per-issue status candidates, the latest valid status signed by a **sibling fork OWNER** who is *not* already in canonical authority, and attaches it as `ResolvedIssue.forkSignal`. The set of fork owners is threaded in as an optional `forkOwners` argument that defaults to empty (so nothing changes until a caller supplies siblings). Discovering the siblings live (querying relays by `euc`) is explicitly **out of scope** — see "Phase 2" at the end; this plan proves the mechanism with the real `a34b99f` fixture.

**Tech Stack:** TypeScript (ESM), vitest, nostr-tools — all already in the repo. No new dependencies.

**Design decisions locked in brainstorming:**
- Approach = **surface**, not full-trust-union and not ignore. Canonical status is still decided only by `owner + announcement maintainers + issue author`.
- Signaler set = sibling fork **owners only** (the pubkey that signed each sibling `30617`), NOT their self-listed maintainers.
- `forkSignal` is a **raw signal**; the resolver stays pure and the UI decides how/whether to display it.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/types.ts` | Event + result shapes | Add `ForkOwner`, `ForkSignal`; add `forkSignal` to `ResolvedIssue` |
| `src/statusResolver.ts` | The pure status fold (single source of truth) | Add `pickForkSignal`; thread `forkOwners` through `resolveIssueStatus`/`resolveIssues` |
| `src/fetch.ts` | Ingest + verify gate, calls the resolver | Thread `forkOwners` through `resolveFromEvents` + `fetchRepo` |
| `test/fixtures.ts` | Synthetic test events | Add `FORK_OWNER`, `FORK_ADDR` |
| `test/statusResolver.test.ts` | Resolver unit tests | New `describe` for cross-fork signal |
| `test/fetch.test.ts` | Fetch pipeline tests | New test: `forkOwners` threads through the verify pipeline |
| `test/realFixture.test.ts` | Real-event regression | Update the `a02eac35` case to assert `forkSignal` |
| `test/fixtures/ngit/README.md` | Fixture manifest | Update the `a02eac35` row |
| `CLAUDE.md`, memory, `docs/handoff.md` | Docs | Record the chosen design + Phase 2 follow-up |

---

## Task 1: `forkSignal` surfaced for a sibling fork owner; non-owners and canonical authority excluded

**Files:**
- Modify: `src/types.ts`
- Modify: `src/statusResolver.ts`
- Modify: `test/fixtures.ts`
- Test: `test/statusResolver.test.ts`

- [ ] **Step 1: Add fork-owner fixtures**

In `test/fixtures.ts`, after the `RANDO` export (line ~13), add:

```typescript
// A sibling fork's OWNER in the same euc group: a legitimate co-maintainer who
// is NOT in this repo's announcement authority. Their status is a signal, not law.
export const FORK_OWNER = "npub_fork_owner";
export const FORK_ADDR = `30617:${FORK_OWNER}:my-repo`;
```

- [ ] **Step 2: Write the failing tests**

In `test/statusResolver.test.ts`, update the import on line 4 to add the new fixtures:

```typescript
import { authority, issue, status, AUTHOR, MAINT, OWNER, RANDO, FORK_OWNER, FORK_ADDR } from "./fixtures";
```

Then append this `describe` block to the end of the file:

```typescript
describe("cross-fork signal (finding #2 x #4): surface, do not trust", () => {
  const siblings = [{ owner: FORK_OWNER, coord: FORK_ADDR }];

  it("surfaces a sibling fork owner's status without changing canonical state", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, siblings);
    expect(r.state).toBe("open"); // canonical status is unchanged
    expect(r.decidedBy).toBeNull();
    expect(r.forkSignal).not.toBeNull();
    expect(r.forkSignal?.state).toBe("resolved");
    expect(r.forkSignal?.by).toBe(FORK_OWNER);
    expect(r.forkSignal?.forkCoord).toBe(FORK_ADDR);
  });

  it("does NOT surface a signal from a non-owner third party (owners-only)", () => {
    const i = issue();
    // RANDO is neither canonical authority nor a fork owner -> no signal at all.
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: RANDO, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, siblings);
    expect(r.state).toBe("open");
    expect(r.forkSignal).toBeNull();
  });

  it("does NOT surface a signal from someone already in canonical authority", () => {
    const i = issue();
    // MAINT decides canonically; even if redundantly listed as a fork owner, no double-report.
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, [{ owner: MAINT, coord: FORK_ADDR }]);
    expect(r.state).toBe("resolved");
    expect(r.decidedBy).not.toBeNull();
    expect(r.forkSignal).toBeNull();
  });

  it("emits no signal when no forkOwners are provided (default behavior unchanged)", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority);
    expect(r.forkSignal).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/statusResolver.test.ts`
Expected: FAIL — the new block errors because `resolveIssueStatus`'s 4th argument and `ResolvedIssue.forkSignal` do not exist yet (TypeScript-stripped at runtime, so `r.forkSignal` is `undefined`, failing `not.toBeNull()` / accessor assertions).

- [ ] **Step 4: Add the types**

In `src/types.ts`, after the `RepoAuthority` interface (ends line ~48), add:

```typescript
// A sibling fork in the same euc group, identified by the pubkey that signed its
// 30617 announcement. Used as the cross-fork SIGNAL set (owners only, by design).
export interface ForkOwner {
  owner: string; // pubkey from a sibling 30617 announcement
  coord: string; // that sibling's coordinate (30617:pubkey:d)
}

// A non-authoritative status assertion from a sibling fork owner. Surfaced so a
// UI can show "fork X marked this resolved" without flipping canonical state.
export interface ForkSignal {
  state: IssueState; // what the fork owner asserted (e.g. "resolved" / "closed")
  by: string;        // the fork owner's pubkey
  forkCoord: string; // the sibling repo coordinate they own
  at: number;        // created_at of the signalling status event
  event: NostrEvent; // the raw status event (audit trail / debugging)
}
```

Then extend `ResolvedIssue` (currently lines ~50-58) to add the `forkSignal` field:

```typescript
export interface ResolvedIssue {
  issue: NostrEvent;
  state: IssueState;
  // the status event that decided it, or null if status defaulted to Open
  decidedBy: NostrEvent | null;
  // true when two valid status events tied on created_at and we broke the tie
  // deterministically by event id. surfaced so callers can flag/ inspect it.
  ambiguousTimestamp: boolean;
  // a sibling fork OWNER (same euc group) asserted a status we do NOT treat as
  // canonical; null when none. See finding #2 x #4 — surface, don't trust.
  forkSignal: ForkSignal | null;
}
```

- [ ] **Step 5: Implement `pickForkSignal` and thread `forkOwners`**

In `src/statusResolver.ts`, update the import block (lines 1-9) to add the two new types:

```typescript
import {
  NostrEvent,
  RepoAuthority,
  ResolvedIssue,
  IssueState,
  ForkOwner,
  ForkSignal,
  STATUS_KINDS,
  kindToState,
  KIND,
} from "./types";
```

Add this function immediately after `pickWinner` (after line ~73, before `resolveIssueStatus`):

```typescript
/**
 * The cross-fork SIGNAL (finding #2 x #4). NIP-34 repos are co-maintained across
 * fork pubkeys grouped by `euc`; a sibling fork's OWNER can legitimately resolve
 * an issue, but they are not in THIS announcement's authority, so the resolver
 * (correctly) won't change canonical state. We surface their latest status here
 * so a UI can flag it, without trusting it.
 *
 * Owners only, by design: `forkOwners` carries sibling 30617 *owners*, never
 * their self-listed maintainers (which are spoofable). A fork owner who is also
 * canonical authority is excluded — their status already counted in pickWinner.
 */
function pickForkSignal(
  issue: NostrEvent,
  candidates: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[],
): ForkSignal | null {
  if (forkOwners.length === 0) return null;
  const coordByOwner = new Map(forkOwners.map((f) => [f.owner, f.coord]));
  const signals = candidates.filter(
    (s) =>
      STATUS_KINDS.has(s.kind) &&
      statusTargetIssueId(s) === issue.id &&
      coordByOwner.has(s.pubkey) && // a sibling fork OWNER
      !isAuthorized(s.pubkey, issue.pubkey, authority), // not already canonical
  );
  if (signals.length === 0) return null;
  const s = signals[0];
  return {
    state: kindToState(s.kind)!,
    by: s.pubkey,
    forkCoord: coordByOwner.get(s.pubkey)!,
    at: s.created_at,
    event: s,
  };
}
```

Update `resolveIssueStatus` (currently lines ~75-83) to accept `forkOwners` and populate `forkSignal`:

```typescript
export function resolveIssueStatus(
  issue: NostrEvent,
  statusEvents: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[] = [],
): ResolvedIssue {
  const { winner, ambiguous } = pickWinner(issue, statusEvents, authority);
  const state: IssueState = winner ? kindToState(winner.kind)! : "open"; // default Open
  return {
    issue,
    state,
    decidedBy: winner,
    ambiguousTimestamp: ambiguous,
    forkSignal: pickForkSignal(issue, statusEvents, authority, forkOwners),
  };
}
```

Update `resolveIssues` (currently lines ~85-102) to accept and forward `forkOwners`:

```typescript
export function resolveIssues(
  issues: NostrEvent[],
  statusEvents: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[] = [],
): ResolvedIssue[] {
  // index statuses by target issue id once, so this is O(issues + statuses).
  const byIssue = new Map<string, NostrEvent[]>();
  for (const s of statusEvents) {
    if (!STATUS_KINDS.has(s.kind)) continue;
    const target = statusTargetIssueId(s);
    if (!target) continue;
    (byIssue.get(target) ?? byIssue.set(target, []).get(target)!).push(s);
  }
  return issues
    .filter((i) => i.kind === KIND.ISSUE)
    .map((i) => resolveIssueStatus(i, byIssue.get(i.id) ?? [], authority, forkOwners));
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/statusResolver.test.ts`
Expected: PASS — all four new tests plus the 12 originals.

- [ ] **Step 7: Run typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; all tests pass (the `forkSignal` field is additive — existing tests use property access, not deep-equality, so none break).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/statusResolver.ts test/fixtures.ts test/statusResolver.test.ts
git commit -m "feat(resolver): surface cross-fork status signal (owners-only, finding #2x#4)"
```

---

## Task 2: fork signal takes the latest by created_at (determinism)

**Files:**
- Modify: `src/statusResolver.ts:pickForkSignal`
- Test: `test/statusResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `cross-fork signal` describe block in `test/statusResolver.test.ts`:

```typescript
it("takes the fork owner's LATEST status by created_at, regardless of input order", () => {
  const i = issue();
  const older = status({ kind: KIND.STATUS_DRAFT, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
  const newer = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_200 });
  // pass older-first to defeat a naive "first match" implementation.
  const r = resolveIssueStatus(i, [older, newer], authority, [{ owner: FORK_OWNER, coord: FORK_ADDR }]);
  expect(r.forkSignal?.state).toBe("closed");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/statusResolver.test.ts -t "LATEST status by created_at"`
Expected: FAIL — `pickForkSignal` returns `signals[0]` (the draft, `1_700_000_100`), so the assertion gets `"draft"`, not `"closed"`.

- [ ] **Step 3: Add the sort**

In `src/statusResolver.ts`, in `pickForkSignal`, replace `const s = signals[0];` with a sort (mirroring `pickWinner`'s tie-break) before taking the head:

```typescript
  // newest created_at wins; tie-break by event id for determinism (as pickWinner).
  signals.sort((a, b) =>
    b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const s = signals[0];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/statusResolver.test.ts -t "LATEST status by created_at"`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/statusResolver.ts test/statusResolver.test.ts
git commit -m "feat(resolver): fork signal takes latest status, deterministic on ties"
```

---

## Task 3: thread `forkOwners` through the fetch verify pipeline

**Files:**
- Modify: `src/fetch.ts` (`resolveFromEvents`, `fetchRepo`)
- Test: `test/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/fetch.test.ts`, add this test inside the existing `describe("resolveFromEvents — pipeline ties fetch to resolver", ...)` block (after the last `it`, before the block's closing `});` on line ~119):

```typescript
  it("threads forkOwners through the verify pipeline to surface a fork signal", () => {
    const i = issue({ eventId: "fi1" });
    // RANDO owns a sibling fork; their valid-sig close is a SIGNAL, not canonical.
    const forkClose = sign(
      status({ kind: KIND.STATUS_CLOSED, issueId: "fi1", by: RANDO, at: 1_700_000_100 }),
    );
    const r = resolveFromEvents(announcement, [sign(i)], [forkClose], fakeVerify, [
      { owner: RANDO, coord: `30617:${RANDO}:my-repo` },
    ]);
    expect(r.resolved[0].state).toBe("open"); // canonical unchanged
    expect(r.resolved[0].forkSignal?.state).toBe("closed");
    expect(r.resolved[0].forkSignal?.by).toBe(RANDO);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/fetch.test.ts -t "threads forkOwners"`
Expected: FAIL — `resolveFromEvents` ignores the 5th argument, so `forkSignal` is `null` and `?.state` is `undefined`.

- [ ] **Step 3: Implement the threading**

In `src/fetch.ts`, add `ForkOwner` to the types import (line ~2):

```typescript
import { NostrEvent, RepoAuthority, ResolvedIssue, ForkOwner, KIND, STATUS_KINDS } from "./types";
```

Update `resolveFromEvents` (signature line ~100-105 and the `resolveIssues` call ~114) — add the `forkOwners` parameter AFTER `verify` (do not reorder; `verify` is passed positionally by existing tests) and forward it:

```typescript
export function resolveFromEvents(
  announcement: NostrEvent,
  rawIssues: RawEvent[],
  rawStatuses: RawEvent[],
  verify: Verifier = defaultVerify,
  forkOwners: ForkOwner[] = [],
): FetchResult {
  const coord = repoCoord(announcement);
  const authority = repoAuthority(announcement);

  const issues = verifyAll(rawIssues, verify);
  // finding #1: keep only issues whose ROOT target is this repo; pure mentions out.
  const belonging = issues.valid.filter((i) => issueTargets(i).primary.includes(coord));

  const statuses = verifyAll(rawStatuses, verify);
  const resolved = resolveIssues(belonging, statuses.valid, authority, forkOwners);

  return {
    coord,
    authority,
    resolved,
    stats: {
      issuesFetched: rawIssues.length,
      issuesDropped: issues.dropped,
      issuesBelonging: belonging.length,
      statusesFetched: rawStatuses.length,
      statusesDropped: statuses.dropped,
    },
  };
}
```

Update `fetchRepo` — add `forkOwners` to its `opts` (signature line ~137-140) and forward it to `resolveIssues` (line ~163):

```typescript
export async function fetchRepo(
  announcement: NostrEvent,
  opts: { relays?: string[]; query?: QueryFn; verify?: Verifier; forkOwners?: ForkOwner[] } = {},
): Promise<FetchResult> {
```

and:

```typescript
  const authority = repoAuthority(announcement);
  const resolved = resolveIssues(belonging, statuses.valid, authority, opts.forkOwners ?? []);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/fetch.test.ts -t "threads forkOwners"`
Expected: PASS.

- [ ] **Step 5: Run typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; all pass.

- [ ] **Step 6: Commit**

```bash
git add src/fetch.ts test/fetch.test.ts
git commit -m "feat(fetch): thread forkOwners through resolveFromEvents and fetchRepo"
```

---

## Task 4: update the real-event fixture regression to assert the fork signal

**Files:**
- Modify: `test/realFixture.test.ts`
- Modify: `test/fixtures/ngit/README.md`

- [ ] **Step 1: Update the fixture test (write the new expectation)**

In `test/realFixture.test.ts`, replace the `r` construction (the line `const r = resolveFromEvents(repo, issues, statuses);`) with a version that supplies the real sibling fork owner `a34b99f` (the co-maintained ngit fork from finding #2). Add the constant just above it:

```typescript
// The co-maintained ngit fork from finding #2 — a sibling 30617 OWNER. Supplied
// here directly; live euc-group discovery that finds this automatically is Phase 2.
const A34 = "a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
const r = resolveFromEvents(repo, issues, statuses, undefined, [
  { owner: A34, coord: `30617:${A34}:ngit` },
]);
```

Then replace the entire `it("finding #2 x #4: a fork co-owner's close is unauthorized — issue stays OPEN", ...)` test with:

```typescript
  it("finding #2 x #4: a fork co-owner's close surfaces as a SIGNAL; canonical stays OPEN", () => {
    // a02eac35 carries a real, valid-signature 1632 (Closed) from a34b99f… (the
    // co-maintained fork's owner). It is NOT in this announcement's authority, so
    // canonical state stays Open — but it is now surfaced as a forkSignal a UI can
    // show as "maybe resolved". If a future change unions euc authority, update
    // this test on purpose.
    const forkClosed = byId("a02eac35");
    expect(forkClosed?.state).toBe("open");
    expect(forkClosed?.decidedBy).toBeNull();
    expect(forkClosed?.forkSignal?.state).toBe("closed");
    expect(forkClosed?.forkSignal?.by).toBe(A34);
  });
```

Also add a `forkSignal` null-check to the existing finding #4 test to prove ordinary issues carry no signal — inside `it("finding #4: authorized status events decide state; statusless defaults Open", ...)`, append:

```typescript
    expect(byId("20a2e386")?.forkSignal).toBeNull(); // no fork owner touched it
```

- [ ] **Step 2: Run the fixture test to verify it passes**

Run: `npx vitest run test/realFixture.test.ts`
Expected: PASS — 6 tests, including the rewritten finding #2 × #4 assertion.

- [ ] **Step 3: Verify teeth — flip one assertion and watch it fail**

Temporarily change `expect(forkClosed?.forkSignal?.state).toBe("closed");` to `toBe("resolved")`.
Run: `npx vitest run test/realFixture.test.ts -t "finding #2 x #4"`
Expected: FAIL with `expected 'closed' to be 'resolved'`. Then revert the change and re-run to confirm PASS.

- [ ] **Step 4: Update the fixture README manifest**

In `test/fixtures/ngit/README.md`, replace the `a02eac35` table row with:

```markdown
| `a02eac35` | **finding #2 × #4** — a valid 1632 (Closed) from the co-maintained fork owner `a34b99f…`; not in this announcement's authority, so canonical state stays **open** but it surfaces as a `forkSignal` (see `test/realFixture.test.ts`) |
```

- [ ] **Step 5: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: tsc exit 0; all pass.

- [ ] **Step 6: Commit**

```bash
git add test/realFixture.test.ts test/fixtures/ngit/README.md
git commit -m "test(fixture): assert cross-fork signal on the real a34b99f close"
```

---

## Task 5: document the chosen design and the Phase 2 follow-up

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/handoff.md`
- Modify: memory `euc-group-authority-gap.md` (path: `<.claude memory>/euc-group-authority-gap.md`)

No tests (documentation only).

- [ ] **Step 1: Update CLAUDE.md finding #2**

In `CLAUDE.md`, under "Four findings", append to the finding #2 paragraph:

```markdown
   The resolver now SURFACES a sibling fork owner's status as a non-authoritative
   `forkSignal` on `ResolvedIssue` (owners only; canonical state unchanged). The
   euc-group *discovery* that feeds those owners in live is still pending (Phase 2).
```

- [ ] **Step 2: Update docs/handoff.md with the Phase 2 scope**

Append a section to `docs/handoff.md`:

```markdown
## Next: Phase 2 — live euc-group discovery

The resolver surfaces `forkSignal` when given `forkOwners` (sibling 30617 owners),
proven by `test/realFixture.test.ts`. What is NOT done: discovering those siblings
live. Build `discoverSiblings(announcement, relays, query)` that, given a repo's
`euc` (`repoEuc()`), finds other 30617 announcements sharing it and returns
`{ owner, coord }[]` (excluding self), then pass them to `fetchRepo({ forkOwners })`.

Open question to verify live (mirror how discoverAnnouncement was verified): do
relays index the `euc` so a server-side filter works, or must we discover siblings
another way (e.g. a maintainers graph / the opt-in registry)? `30617` stores euc as
`["r", "<euc>", "euc"]`; test whether `nak req -k 30617 -t r=<euc>` returns the
group on relay.ngit.dev before committing to that path.
```

- [ ] **Step 3: Update the memory file**

Edit `<.claude memory>/euc-group-authority-gap.md`: change "How to apply" to record that the **surface** approach (owners-only) was chosen and Phase 1 landed, and that Phase 2 (live euc discovery) is the remaining work. Keep the `[[prana-fetch-discovery-cap]]` link.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/handoff.md
git commit -m "docs: record cross-fork signal design + Phase 2 euc discovery follow-up"
```

(The memory file lives outside the repo and is not committed.)

---

## Out of scope (Phase 2, separate plan)

- **Live euc-group discovery** — querying relays to find sibling `30617`s by shared `euc` and building the `forkOwners` list automatically. Until this lands, `fetchRepo`/`fetch live` pass no siblings, so `forkSignal` is always null in production; the mechanism is exercised only by tests. This is deliberate: discovery is an I/O subsystem with an unverified relay-indexing assumption and deserves its own live-verification pass.
- **UI treatment** of `forkSignal` (badging "maybe resolved", filtering). The resolver intentionally emits a raw signal and makes no display decision.
- **Authority union** (actually trusting sibling maintainers to change canonical state) — explicitly rejected in brainstorming in favor of surfacing.

---

## Self-Review

- **Spec coverage:** approach=surface ✅ (Task 1, canonical untouched); owners-only ✅ (Task 1 non-owner test); raw signal / pure resolver ✅ (`ForkSignal` carries raw `event`, no display logic); determinism ✅ (Task 2); fetch wiring ✅ (Task 3); real-data proof ✅ (Task 4); docs + Phase 2 ✅ (Task 5).
- **Type consistency:** `ForkOwner { owner, coord }` and `ForkSignal { state, by, forkCoord, at, event }` are used identically in `types.ts`, `pickForkSignal`, the threading, and all tests. `forkOwners` is the 4th arg of `resolveIssueStatus`/`resolveIssues`, the 5th of `resolveFromEvents`, and `opts.forkOwners` on `fetchRepo` — consistent across tasks.
- **Placeholder scan:** no TBD/"handle edge cases"/uncoded steps; every code step shows full code.
- **Backward compatibility:** every new parameter defaults to `[]`; existing call sites in `analyze.ts`, `fetch.ts`, and all current tests pass 3 args and are unaffected; `forkSignal` is additive and existing tests use property access, not deep-equality.
