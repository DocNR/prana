# Fetch Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the cross-repo worklist from silently dropping a repo when its `30617` discovery query transiently times out (tracked as ngit issue `122478d0`).

**Architecture:** Today every relay query opens and immediately closes its own `SimplePool` (`defaultQuery` in `src/fetch.ts`). One registry run does this many times in quick succession, so WebSocket connect/disconnect churn plus a short `querySync` EOSE wait lets a slow relay's answer arrive *after* `querySync` already resolved empty → `discoverAnnouncement` throws → `registry.ts` `main()` catches and skips the whole repo. The fix is resilience-only: (1) reuse **one** warm `SimplePool` for the entire registry run via the already-injectable `QueryFn`, closing it **once** at the end; (2) give that shared query a **generous `maxWait`** so slow relays get time to answer; (3) **retry `discoverAnnouncement` once** on an empty result before throwing.

**Tech Stack:** TypeScript, `nostr-tools` (`SimplePool.querySync` / `.destroy()`), vitest. Conventions: TDD (failing test first), minimal diffs, all tests stay green (132 at baseline), frequent commits.

**Scope guardrails:**
- Do **not** change `buildClaimEvent`, the status/claim folds, the resolver, or any rendering.
- `defaultQuery`'s existing per-query-pool behavior stays byte-for-byte unchanged (single-repo CLI paths keep working exactly as before); the shared-pool path is additive.
- **Out of scope (follow-up, do NOT build):** surfacing a visible "couldn't reach repo X" row in the UI for a *genuinely unreachable* repo. This task only prevents dropping a repo on a *transient* failure.
- `src/worklist.ts` live path is single-repo, so it cannot exhibit the "drops a repo" symptom; it automatically benefits from the `discoverAnnouncement` retry (Task 2) with no edit. Leave it unchanged.

---

## File Structure

- `src/fetch.ts` — export the existing `defaultQuery`; add a `poolQuery(pool, maxWait)` factory that builds a `QueryFn` over a caller-owned, reused pool; add a single retry inside `discoverAnnouncement`.
- `src/registry.ts` — add `opts: { query?, verify? }` to `fetchRepoInput` and thread it through discover + fetch + the claim query (removing the inline per-call `SimplePool`); add an exported `fetchRegistryInputs(refs, fallbackRelays, query, verify?)` helper that loops every ref through ONE shared query (skip-not-fail on error); rewire `main()` to build one pool, run the helper, and `destroy()` once in `finally`.
- `src/server.ts` — rewire `buildHtml()` to use one shared pool + `fetchRegistryInputs` + `destroy()` in `finally` (drops the now-duplicated loop and the `fetchRepoInput`/`RepoInput` imports it no longer needs).
- `test/fetch.test.ts` — tests for `poolQuery` and the `discoverAnnouncement` retry.
- `test/registry.test.ts` — tests for `fetchRepoInput` query/verify threading and the `fetchRegistryInputs` "both repos survive a transient miss" behavior.

---

## Task 1: `poolQuery` factory + export `defaultQuery`

**Files:**
- Modify: `src/fetch.ts:86-96` (the `defaultQuery` const)
- Test: `test/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/fetch.test.ts`. First extend the import at the top (line 2-10) to include `poolQuery`:

```typescript
import {
  verifyAll,
  resolveFromEvents,
  fetchRepo,
  discoverAnnouncement,
  poolQuery,
  RawEvent,
  Verifier,
  QueryFn,
} from "../src/fetch";
import type { SimplePool } from "nostr-tools";
```

Then add this describe block at the end of the file:

```typescript
describe("poolQuery — shared warm pool (no per-query close)", () => {
  it("queries the caller's pool with a generous maxWait and never closes it", async () => {
    const calls: { relays: string[]; params: unknown }[] = [];
    let closed = false;
    const fakePool = {
      querySync: async (relays: string[], _filter: unknown, params: unknown) => {
        calls.push({ relays, params });
        return [sign(issue())];
      },
      close: () => {
        closed = true;
      },
      destroy: () => {
        closed = true;
      },
    } as unknown as SimplePool;

    const query = poolQuery(fakePool);
    const res = await query(["wss://relay.one"], { kinds: [KIND.ISSUE] });

    expect(res).toHaveLength(1);
    expect((calls[0].params as { maxWait?: number }).maxWait).toBe(5000);
    expect(calls[0].relays).toEqual(["wss://relay.one"]);
    expect(closed).toBe(false); // the CALLER owns the pool lifecycle, not the query
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fetch.test.ts -t "shared warm pool"`
Expected: FAIL — `poolQuery` is not exported (`poolQuery is not a function` / import error).

- [ ] **Step 3: Write minimal implementation**

In `src/fetch.ts`, change the `defaultQuery` declaration to be exported and add the `poolQuery` factory immediately after it. Replace lines 83-96 (the `QueryFn` type comment through the end of `defaultQuery`) with:

```typescript
/** Relay query function. Injectable so the live path can be tested with a mock. */
export type QueryFn = (relays: string[], filter: Filter) => Promise<RawEvent[]>;

export const defaultQuery: QueryFn = async (relays, filter) => {
  const pool = new SimplePool();
  try {
    // our Filter is a structural subset of nostr-tools' (which has a `#<tag>`
    // index signature); cast at this one boundary rather than leak their type.
    const f = filter as Parameters<typeof pool.querySync>[1];
    return (await pool.querySync(relays, f)) as RawEvent[];
  } finally {
    pool.close(relays);
  }
};

/**
 * Build a QueryFn over a caller-owned pool that is REUSED across every query in a
 * run and closed ONCE by the caller (do NOT close per query). The generous
 * `maxWait` gives a slow relay time to answer, so a registry run's connect/
 * disconnect churn can't make a real response land after querySync already
 * resolved empty — the root cause of a repo being silently dropped from the
 * worklist (ngit issue 122478d0).
 */
export function poolQuery(pool: SimplePool, maxWait = 5000): QueryFn {
  return async (relays, filter) => {
    const f = filter as Parameters<typeof pool.querySync>[1];
    return (await pool.querySync(relays, f, { maxWait })) as RawEvent[];
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/fetch.test.ts -t "shared warm pool"`
Expected: PASS

- [ ] **Step 5: Run the full fetch suite + typecheck**

Run: `npx vitest run test/fetch.test.ts && npm run typecheck`
Expected: all fetch tests PASS (18 now), typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/fetch.ts test/fetch.test.ts
git commit -m "feat(fetch): add poolQuery factory + export defaultQuery"
```

---

## Task 2: Retry `discoverAnnouncement` once on an empty result

**Files:**
- Modify: `src/fetch.ts:147-165` (the `discoverAnnouncement` function)
- Test: `test/fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the existing `describe("discoverAnnouncement — ...")` block in `test/fetch.test.ts`:

```typescript
  it("retries once on a transient empty result, then succeeds (no silent drop)", async () => {
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      return calls === 1 ? [] : [sign(announcement)]; // first miss (transient), second hit
    };
    const found = await discoverAnnouncement(OWNER, "my-repo", ["wss://relay.one"], {
      query,
      verify: fakeVerify,
    });
    expect(found.id).toBe("repo0001");
    expect(calls).toBe(2); // retried exactly once
  });

  it("gives up after retrying when both attempts are empty", async () => {
    let calls = 0;
    const query: QueryFn = async () => {
      calls += 1;
      return [];
    };
    await expect(
      discoverAnnouncement(OWNER, "my-repo", ["wss://relay.one"], { query, verify: fakeVerify }),
    ).rejects.toThrow(/no 30617/);
    expect(calls).toBe(2); // tried twice before throwing
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fetch.test.ts -t "retries once on a transient"`
Expected: FAIL — current code queries only once, so `calls` is `1` (the retry test) and the "gives up" test sees `calls === 1`.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `discoverAnnouncement` (`src/fetch.ts`, the function spanning roughly lines 147-165) with this version. Keep the doc comment above it unchanged:

```typescript
export async function discoverAnnouncement(
  owner: string,
  d: string,
  relays: string[],
  opts: { query?: QueryFn; verify?: Verifier } = {},
): Promise<NostrEvent> {
  const query = opts.query ?? defaultQuery;
  const verify = opts.verify ?? defaultVerify;
  const filter: Filter = { kinds: [KIND.REPO_ANNOUNCEMENT], authors: [owner], "#d": [d] };

  // One query attempt -> client-side belt-and-suspenders match -> signature gate.
  const attempt = async (): Promise<NostrEvent[]> => {
    const raw = await query(relays, filter);
    // a relay may ignore the filter, so match client-side too.
    const matching = raw.filter(
      (e) => e.pubkey === owner && e.tags.some((t) => t[0] === "d" && t[1] === d),
    );
    return verifyAll(matching, verify).valid;
  };

  // Retry once: under per-run connect/disconnect churn a slow relay's response can
  // land after the first querySync resolves empty. A bare retry turns that
  // transient miss into a hit instead of silently dropping the whole repo.
  let verified = await attempt();
  if (!verified.length) verified = await attempt();
  if (!verified.length) throw new Error(`no 30617 for ${owner}:${d} on ${relays.join(", ")}`);

  // replaceable: newest wins; tie-break by id so the choice is deterministic.
  verified.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return verified[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/fetch.test.ts -t "discoverAnnouncement"`
Expected: PASS for all `discoverAnnouncement` tests, including the existing "throws a clear error when the target announcement is absent" (it now calls the query twice but still throws).

- [ ] **Step 5: Run the full fetch suite + typecheck**

Run: `npx vitest run test/fetch.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/fetch.ts test/fetch.test.ts
git commit -m "feat(fetch): retry discoverAnnouncement once on a transient empty result"
```

---

## Task 3: Thread `query` + `verify` through `fetchRepoInput`

**Files:**
- Modify: `src/registry.ts:1-7` (imports), `src/registry.ts:150-177` (`fetchRepoInput`)
- Test: `test/registry.test.ts`

**Why add `verify` too:** `discoverAnnouncement` and `fetchRepo` already accept `verify`, and threading it makes `fetchRepoInput` fully unit-testable offline (a `() => true` verifier accepts mock events). Production callers pass no `verify`, so the real `nostr-tools` `verifyEvent` still runs — behavior unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/registry.test.ts`. First extend the imports at the top so the test can build events and inject a query:

```typescript
import {
  RepoRef,
  repoRefCoord,
  loadRegistry,
  buildMultiRepoWorklist,
  renderMultiRepoWorklist,
  fetchRepoInput,
  RepoInput,
} from "../src/registry";
import { ResolvedIssue, NostrEvent, KIND } from "../src/types";
import { ClaimView } from "../src/worklist";
import { QueryFn, Verifier } from "../src/fetch";
```

Then add this describe block at the end of the file:

```typescript
describe("fetchRepoInput — query/verify threading (resilience)", () => {
  const ann: NostrEvent = {
    id: "annR",
    pubkey: OWNER,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "ngit"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const acceptAll: Verifier = () => true;

  it("survives a transient discover miss and threads ONE injected query through every sub-query", async () => {
    let discoverCalls = 0;
    const kindsSeen: number[] = [];
    const query: QueryFn = async (_relays, filter) => {
      const k = filter.kinds?.[0];
      if (typeof k === "number") kindsSeen.push(k);
      if (filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT)) {
        discoverCalls += 1;
        return discoverCalls === 1 ? [] : [ann]; // first miss (transient), then hit
      }
      return []; // no issues -> no statuses, no claims
    };

    const input = await fetchRepoInput({ owner: OWNER, d: "ngit" }, ["wss://relay.one"], 0, {
      query,
      verify: acceptAll,
    });

    expect(input.ref.d).toBe("ngit"); // repo resolved, NOT skipped
    expect(discoverCalls).toBe(2); // the transient miss was retried
    expect(input.cloneUrl).toBeNull(); // ann carries no clone tag
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts -t "query/verify threading"`
Expected: FAIL to compile — `fetchRepoInput` currently takes 3 args, so the 4th `opts` argument is a type error ("Expected 3 arguments, but got 4").

- [ ] **Step 3: Write minimal implementation**

In `src/registry.ts`, change the fetch import (line 3) from:

```typescript
import { discoverAnnouncement, fetchRepo, RawEvent } from "./fetch";
```

to:

```typescript
import { discoverAnnouncement, fetchRepo, defaultQuery, QueryFn, Verifier } from "./fetch";
```

Then replace the whole `fetchRepoInput` function (lines 150-177) with:

```typescript
export async function fetchRepoInput(
  ref: RepoRef,
  fallbackRelays: string[] = [],
  now: number = Math.floor(Date.now() / 1000),
  opts: { query?: QueryFn; verify?: Verifier } = {},
): Promise<RepoInput> {
  const relays = ref.relays?.length ? ref.relays : fallbackRelays;
  if (!relays.length) {
    throw new Error(`no relays for ${repoRefCoord(ref)}: add "relays" to the registry entry`);
  }
  // One shared query (and verifier) for THIS repo's discover + issues + claims, so a
  // warm pool from the caller is reused instead of churning a fresh socket per query.
  const query = opts.query ?? defaultQuery;
  const verify = opts.verify;
  const announcement = await discoverAnnouncement(ref.owner, ref.d, relays, { query, verify });
  const resolved = (await fetchRepo(announcement, { relays, query, verify })).resolved;

  const openIds = resolved.filter((r) => r.state === "open").map((r) => r.issue.id);
  let claimFor: ((issueId: string) => ClaimView | undefined) | undefined;
  if (openIds.length) {
    const raw = await query(relays, { kinds: [KIND.CLAIM], "#d": openIds });
    claimFor = gatedClaimLookup(raw, openIds, now, verify ? { verify } : undefined);
  }
  const cloneList = repoClone(announcement);
  const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;
  return { ref, resolved, claimFor, relays, cloneUrl };
}
```

Note: this removes the inline `const { SimplePool } = await import("nostr-tools")` claim pool entirely — the claim query now rides the shared `query`. `RawEvent` is no longer referenced in this file, which is why it was dropped from the import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry.test.ts -t "query/verify threading"`
Expected: PASS

- [ ] **Step 5: Run the full registry suite + typecheck**

Run: `npx vitest run test/registry.test.ts && npm run typecheck`
Expected: all PASS, typecheck clean (no "unused RawEvent" error).

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "feat(registry): thread injectable query+verify through fetchRepoInput"
```

---

## Task 4: One shared pool per run — `fetchRegistryInputs` helper + rewire `main()` and `buildHtml()`

**Files:**
- Modify: `src/registry.ts` (imports + add `fetchRegistryInputs` export + rewrite `main()`)
- Modify: `src/server.ts` (imports + rewrite `buildHtml()`)
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/registry.test.ts`. First add `fetchRegistryInputs` to the registry import list:

```typescript
import {
  RepoRef,
  repoRefCoord,
  loadRegistry,
  buildMultiRepoWorklist,
  renderMultiRepoWorklist,
  fetchRepoInput,
  fetchRegistryInputs,
  RepoInput,
} from "../src/registry";
```

Then add this describe block at the end of the file:

```typescript
describe("fetchRegistryInputs — one shared query, no dropped repo (issue 122478d0)", () => {
  const OWNER_B = "b".repeat(64);
  const annA: NostrEvent = {
    id: "annA",
    pubkey: OWNER,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "a"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const annB: NostrEvent = {
    id: "annB",
    pubkey: OWNER_B,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "b"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const acceptAll: Verifier = () => true;

  it("resolves BOTH repos through one shared query even when one repo's discovery transiently misses", async () => {
    let aDiscover = 0;
    const query: QueryFn = async (_relays, filter) => {
      if (filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT)) {
        if (filter["#d"]?.includes("a")) {
          aDiscover += 1;
          return aDiscover === 1 ? [] : [annA]; // repo A: transient miss, then hit
        }
        if (filter["#d"]?.includes("b")) return [annB]; // repo B: immediate hit
      }
      return []; // no issues/statuses/claims for either repo
    };

    const inputs = await fetchRegistryInputs(
      [{ owner: OWNER, d: "a" }, { owner: OWNER_B, d: "b" }],
      ["wss://relay.one"],
      query,
      acceptAll,
    );

    // The bug: a transient miss dropped a repo, so the worklist showed "1 repo(s)".
    // The fix: BOTH repos resolve -> "2 repo(s)".
    expect(inputs.map((i) => i.ref.d).sort()).toEqual(["a", "b"]);
    expect(aDiscover).toBe(2); // repo A's transient miss was retried, not skipped
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts -t "one shared query"`
Expected: FAIL — `fetchRegistryInputs` is not exported (import/type error).

- [ ] **Step 3: Write the implementation**

In `src/registry.ts`:

(a) Add `poolQuery` to the fetch import and `SimplePool` from nostr-tools. The fetch import (set in Task 3) becomes:

```typescript
import { SimplePool } from "nostr-tools";
import { discoverAnnouncement, fetchRepo, defaultQuery, poolQuery, QueryFn, Verifier } from "./fetch";
```

(b) Add the exported helper just above the CLI `main()` (after `fetchRepoInput`):

```typescript
/**
 * Fetch every registry ref through ONE shared query — i.e. one warm SimplePool per
 * run, supplied by the caller — instead of churning a fresh pool per query. A ref
 * that errors is reported and SKIPPED, not fatal, so the directory still renders the
 * repos that resolved. The caller owns the pool lifecycle (close/destroy it once).
 */
export async function fetchRegistryInputs(
  refs: RepoRef[],
  fallbackRelays: string[],
  query: QueryFn,
  verify?: Verifier,
): Promise<RepoInput[]> {
  const inputs: RepoInput[] = [];
  for (const ref of refs) {
    try {
      inputs.push(await fetchRepoInput(ref, fallbackRelays, undefined, { query, verify }));
    } catch (e) {
      console.error(`! skipped ${repoRefCoord(ref)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return inputs;
}
```

(c) Rewrite `main()` to build one pool, run the helper, and `destroy()` once in `finally`:

```typescript
async function main(): Promise<void> {
  const [registryPath, ...fallbackRelays] = process.argv.slice(2);
  if (!registryPath) throw new Error("usage: registry <registry.json> [fallbackRelay...]");

  const refs = loadRegistry(registryPath);
  const pool = new SimplePool();
  try {
    const inputs = await fetchRegistryInputs(refs, fallbackRelays, poolQuery(pool));
    console.log(renderMultiRepoWorklist(await buildMultiRepoWorklist(inputs)));
  } finally {
    pool.destroy(); // close the warm pool ONCE, at the end of the run
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/registry.test.ts -t "one shared query"`
Expected: PASS

- [ ] **Step 5: Rewire `src/server.ts` `buildHtml()` to share one pool**

Replace the imports (lines 1-3) from:

```typescript
import { createServer } from "node:http";
import { loadRegistry, fetchRepoInput, buildMultiRepoWorklist, RepoInput } from "./registry";
import { renderWorklistHtml } from "./webui";
```

to:

```typescript
import { createServer } from "node:http";
import { SimplePool } from "nostr-tools";
import { loadRegistry, fetchRegistryInputs, buildMultiRepoWorklist } from "./registry";
import { poolQuery } from "./fetch";
import { renderWorklistHtml } from "./webui";
```

Replace the whole `buildHtml` function (lines 20-31) with:

```typescript
async function buildHtml(): Promise<string> {
  const refs = loadRegistry(registryPath);
  const pool = new SimplePool();
  try {
    const inputs = await fetchRegistryInputs(refs, fallbackRelays, poolQuery(pool));
    return renderWorklistHtml(await buildMultiRepoWorklist(inputs));
  } finally {
    pool.destroy(); // one warm pool per build; close it once
  }
}
```

- [ ] **Step 6: Run the FULL suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: ALL tests PASS (≈138: 132 baseline + the new resilience tests), typecheck clean. No unused-import errors in `registry.ts` or `server.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/registry.ts src/server.ts test/registry.test.ts
git commit -m "feat(registry,server): reuse one warm SimplePool per run, never drop a repo on a transient miss"
```

---

## Live Verification (after all tasks green)

Run from the repo root:

```bash
npm run registry registry.json   # repeat 4-5 times
```
Expected: the summary line consistently reads `... open across 2 repo(s) ...` on every run — never `1 repo(s)`, never bouncing between only-prana / only-ngit / both.

```bash
npm run serve registry.json
```
Then load `http://localhost:8787/` and refresh several times (the page caches for 60s; wait for the TTL or restart to force fresh fetches). Expected: both repos render every time.

If a run still shows 1 repo, that points to a *genuinely* unreachable relay (out of scope here — the follow-up "show an unreachable-repo row" task), not the transient drop this plan fixes. Note it; don't expand scope.

---

## Follow-up — DONE (separate branch `feat/unreachable-repo-row`)

Surface a visible "couldn't reach repo X" row in the worklist when a repo is genuinely unreachable, instead of silently omitting it. This plan deliberately only prevented dropping a repo on a *transient* failure; a persistently-down relay still dropped its repo silently.

Built: `fetchRegistryInputs` now returns `{ inputs, unreachable }` — a failed ref becomes an `UnreachableRepo { ref, error }` marker instead of being dropped. `renderMultiRepoWorklist` prints a `! N repo(s) unreachable` footer; `renderWorklistHtml` renders a `role="alert"` banner above the table (label + error, both escaped). `buildMultiRepoWorklist`, the folds, and `buildClaimEvent` are unchanged.

---

## Self-Review

- **Spec coverage:** (1) reuse one warm pool per run → Task 4 (`SimplePool` in `main()`/`buildHtml()`, `poolQuery`, `destroy()` in `finally`). (2) generous `maxWait` → Task 1 (`poolQuery` passes `maxWait: 5000`). (3) retry `discoverAnnouncement` once on empty → Task 2. Threading `query` through `fetchRepoInput → discover + fetch + claim` → Task 3. Tests for retry + "repo not skipped" + single shared query across repos → Tasks 2/3/4. All covered.
- **Type consistency:** `QueryFn` and `Verifier` are imported from `./fetch` in both the test and `registry.ts`. `poolQuery(pool, maxWait=5000)` returns a `QueryFn`. `fetchRepoInput(ref, fallbackRelays, now, opts)` and `fetchRegistryInputs(refs, fallbackRelays, query, verify?)` signatures match every call site (`main()`, `buildHtml()`, both new tests). `gatedClaimLookup(raw, openIds, now, opts?)` is called with `verify ? { verify } : undefined`, matching its `opts?: { verify?, maxTtl? }` signature in `src/worklist.ts`.
- **Placeholder scan:** none — every code step shows full code.
- **Behavior-unchanged check:** `defaultQuery` keeps its own-pool/no-maxWait body; production `main()`/`buildHtml()` pass no `verify`, so real `verifyEvent` still gates. Folds, `buildClaimEvent`, and rendering are untouched.
