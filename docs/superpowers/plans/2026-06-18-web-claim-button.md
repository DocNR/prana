# Web claim/release button + clone link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a visitor claim/release an issue and grab its clone URL directly from the web worklist, signed by their own signer — closing the contributor loop.

**Architecture:** The server stays read-only. Each available row carries the repo's registry-trusted relays, a clone URL, and an unsigned claim *skeleton* (pre-built by the real `buildClaimEvent`). In the browser, `window.nostr.js` signs (NIP-07 or NIP-46/Clave) and a tiny raw-WebSocket helper publishes to those relays; the row flips optimistically once a trusted relay confirms.

**Tech Stack:** TypeScript + tsx, vitest, `nostr-tools` (Node side), `window.nostr.js` (browser, CDN+SRI), no bundler.

**Spec:** `docs/superpowers/specs/2026-06-18-web-claim-button-design.md` (read it; this plan implements its decisions + adversarial dispositions).

---

## File structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/claimEvent.ts` | **new** — the pure claim-event builder (`buildClaimEvent`, `parseTtl`, `DEFAULT_TTL_SECONDS`, `ClaimTemplate`, `BuildClaimOpts`). No Node/nostr-tools deps. | create (moved out of `claim.ts`) |
| `src/claim.ts` | CLI edge (sign/publish). Re-exports the builder from `claimEvent.ts`. | modify |
| `src/nip34.ts` | add `repoClone(repo)` (read `clone` tag), mirroring `repoRelays`. | modify |
| `src/registry.ts` | thread `relays`/`cloneUrl` onto `RepoInput`; attach `relays`/`cloneUrl`/`claimSkeleton` onto `MultiRepoItem`. | modify |
| `src/webui.ts` | pure helpers `claimRelays`/`safeClone`; render Claim/Release control, clone affordance, `data-*`; WNJ script + inline client handler. | modify |
| `src/server.ts` | none of substance (items now richer; stays read-only). | none |
| `test/nip34.test.ts` | **new** — `repoClone` cases. | create |
| `test/webui.test.ts` | extend `item()` helper + add render/XSS/parity tests. | modify |
| `test/registry.test.ts` | assert `MultiRepoItem` carries relays/cloneUrl/skeleton. | modify |
| `test/claim.test.ts` | unchanged (imports still resolve via re-export). | none |

Note: `webui.ts` uses `MultiRepoItem` and `ClaimTemplate` **as types only** (erased at compile), so it stays runtime-pure — do not add a value import of `registry.ts`/`claimEvent.ts` to it.

---

## Task 1: Extract the pure claim-event builder (refactor, no behavior change)

**Files:**
- Create: `src/claimEvent.ts`
- Modify: `src/claim.ts`

- [ ] **Step 1: Create `src/claimEvent.ts` with the pure core moved verbatim from `claim.ts`**

```ts
import { KIND } from "./types";
import { MAX_TTL_SECONDS } from "./claimFetch";

/** Default claim TTL when the CLI is given no `--ttl`. Short by design — a claim is a
 *  soft "I'm on this", not a lease; it should lapse quickly if the worker walks away. */
export const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days

/** An unsigned Nostr event template (NIP-01). Structurally a nostr-tools `EventTemplate`. */
export interface ClaimTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BuildClaimOpts {
  now: number;
  ttlSeconds?: number;
  release?: boolean;
}

export function buildClaimEvent(issueId: string, opts: BuildClaimOpts): ClaimTemplate {
  if (!issueId) throw new Error("issueId is required");
  const release = opts.release ?? false;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`ttlSeconds must be a positive integer (got ${ttl})`);
  }
  if (ttl > MAX_TTL_SECONDS) {
    throw new Error(`ttl ${ttl}s exceeds the ${MAX_TTL_SECONDS}s (14-day) horizon`);
  }
  // Both claim and release carry a FUTURE expiration (now + ttl). A release must NOT
  // expire at/before its own created_at: NIP-40 relays reject already-expired events.
  const expiry = opts.now + ttl;
  return {
    kind: KIND.CLAIM,
    created_at: opts.now,
    tags: [
      ["d", issueId],
      ["e", issueId, "", "root"],
      ["expiration", String(expiry)],
      ["status", release ? "released" : "claimed"],
    ],
    content: "",
  };
}

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseTtl(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input.trim());
  if (!m) throw new Error(`bad --ttl "${input}": use a number + unit, e.g. 3d, 12h, 30m, 45s`);
  const n = Number(m[1]);
  if (n <= 0) throw new Error(`--ttl must be positive (got "${input}")`);
  return n * TTL_UNITS[m[2]];
}
```

- [ ] **Step 2: In `src/claim.ts`, delete the moved definitions and import + re-export them from `claimEvent.ts`**

Remove from `claim.ts`: the `DEFAULT_TTL_SECONDS`, `ClaimTemplate`, `BuildClaimOpts`, `buildClaimEvent`, `TTL_UNITS`, and `parseTtl` definitions, and the now-unused `import { KIND } from "./types"` / `import { MAX_TTL_SECONDS } from "./claimFetch"` **only if** nothing else in `claim.ts` uses them (it uses `MAX_TTL_SECONDS` in `parseArgs` and `HEX64`; keep `MAX_TTL_SECONDS`). Add at the top, after the existing imports:

```ts
import {
  buildClaimEvent,
  parseTtl,
  DEFAULT_TTL_SECONDS,
  type ClaimTemplate,
  type BuildClaimOpts,
} from "./claimEvent";

// Re-export so existing importers (`from "./claim"`) keep working.
export { buildClaimEvent, parseTtl, DEFAULT_TTL_SECONDS };
export type { ClaimTemplate, BuildClaimOpts };
```

Keep `import { MAX_TTL_SECONDS } from "./claimFetch";` (still used by `parseArgs`).

- [ ] **Step 3: Run the full suite — behavior unchanged, all green**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; **118 passed** (no test changes; `claim.test.ts` resolves the re-exports).

- [ ] **Step 4: Commit**

```bash
git add src/claimEvent.ts src/claim.ts
git commit -m "refactor(claim): extract pure buildClaimEvent into claimEvent.ts (no behavior change)"
```

---

## Task 2: `repoClone` in nip34.ts

**Files:**
- Create: `test/nip34.test.ts`
- Modify: `src/nip34.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { repoClone } from "../src/nip34";
import { NostrEvent, KIND } from "../src/types";

const ann = (tags: string[][]): NostrEvent => ({
  id: "a".repeat(64), pubkey: "b".repeat(64), created_at: 1,
  kind: KIND.REPO_ANNOUNCEMENT, tags, content: "",
});

describe("repoClone", () => {
  it("returns all clone urls across one or more `clone` tags, deduped", () => {
    const r = ann([["clone", "https://a.git", "https://b.git"], ["clone", "https://a.git"]]);
    expect(repoClone(r)).toEqual(["https://a.git", "https://b.git"]);
  });
  it("returns [] when there is no clone tag", () => {
    expect(repoClone(ann([["relays", "wss://x"]]))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run test/nip34.test.ts`
Expected: FAIL — `repoClone is not a function`.

- [ ] **Step 3: Implement `repoClone` in `src/nip34.ts`** (add directly after `repoRelays`)

```ts
/** Clone URL(s) advertised by the announcement's `clone` tag(s) (NIP-34). Like `relays`,
 *  a `clone` tag may hold several urls inline; tolerate multiple tags and dedupe. */
export function repoClone(repo: NostrEvent): string[] {
  const out: string[] = [];
  for (const t of repo.tags)
    if (t[0] === "clone") out.push(...t.slice(1).filter(Boolean));
  return [...new Set(out)];
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run test/nip34.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/nip34.ts test/nip34.test.ts
git commit -m "feat(nip34): add repoClone to read 30617 clone urls"
```

---

## Task 3: Pure web helpers `claimRelays` + `safeClone`

**Files:**
- Modify: `src/webui.ts`
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside `test/webui.test.ts`)

```ts
import { claimRelays, safeClone } from "../src/webui";

describe("claimRelays", () => {
  it("keeps only wss: urls, dedupes, and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`);
    expect(claimRelays(["wss://a", "wss://a", "ws://insecure", "https://x", "not-a-url"]))
      .toEqual(["wss://a"]);
    expect(claimRelays(many)).toHaveLength(8);
  });
});

describe("safeClone", () => {
  it("returns an href for http(s)", () => {
    expect(safeClone("https://example.com/r.git")).toEqual({ kind: "href", url: "https://example.com/r.git" });
  });
  it("returns inert text for nostr:", () => {
    expect(safeClone("nostr://npub1abc/repo")).toEqual({ kind: "text", url: "nostr://npub1abc/repo" });
  });
  it("drops javascript:, data:, vbscript:, and junk (case/space-insensitive)", () => {
    for (const u of ["javascript:alert(1)", "  javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "vbscript:x", "nope"])
      expect(safeClone(u)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run test/webui.test.ts`
Expected: FAIL — `claimRelays`/`safeClone` not exported.

- [ ] **Step 3: Implement the helpers in `src/webui.ts`** (add near the top, after `escapeHtml`)

```ts
/** Publish targets, sanitized: parse, keep only `wss:`, dedupe, cap at 8 (spec review #2). */
export function claimRelays(relays: string[]): string[] {
  const out: string[] = [];
  for (const r of relays) {
    let u: URL;
    try { u = new URL(r); } catch { continue; }
    if (u.protocol !== "wss:") continue;
    if (!out.includes(u.href)) out.push(u.href);
    if (out.length === 8) break;
  }
  return out;
}

/** A clone URL classified for safe rendering (spec review #5). `new URL().protocol` is the
 *  only robust scheme check — string matching is bypassable. */
export function safeClone(clone: string): { kind: "href" | "text"; url: string } | null {
  let u: URL;
  try { u = new URL(clone); } catch { return null; }
  if (u.protocol === "http:" || u.protocol === "https:") return { kind: "href", url: clone };
  if (u.protocol === "nostr:") return { kind: "text", url: clone };
  return null; // javascript:, data:, vbscript:, … → dropped
}
```

Note: `new URL("wss://a")` yields `href` `"wss://a/"` (trailing slash) — the test expects `"wss://a"`. Fix the test expectation to `"wss://a/"`, OR strip a lone trailing slash. Choose **strip**: change the dedupe push to `const href = u.href.replace(/\/$/, "");`. Update both `claimRelays` and re-run.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/webui.test.ts`
Expected: PASS (new describes green; existing render tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): add claimRelays + safeClone sanitizers (XSS/SSRF guards)"
```

---

## Task 4: Thread relays + cloneUrl onto RepoInput and MultiRepoItem

**Files:**
- Modify: `src/registry.ts`
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test** (append in `test/registry.test.ts`; mirror its existing `RepoInput` construction style)

```ts
import { buildMultiRepoWorklist, RepoInput } from "../src/registry";
// (reuse the file's existing helpers to build a ResolvedIssue that is `state: "open"`)

it("carries relays, cloneUrl, and a claim skeleton onto each item", async () => {
  const id = "a".repeat(64);
  const input: RepoInput = {
    ref: { owner: "1".repeat(64), d: "demo", name: "demo" },
    relays: ["wss://relay.one"],
    cloneUrl: "https://demo.example/r.git",
    resolved: [{
      issue: { id, pubkey: "2".repeat(64), created_at: 1, kind: 1621, tags: [["subject", "demo issue"]], content: "" },
      state: "open", decidedBy: null, ambiguousTimestamp: false, forkSignal: null,
    }],
  };
  const items = await buildMultiRepoWorklist([input]);
  expect(items[0].relays).toEqual(["wss://relay.one"]);
  expect(items[0].cloneUrl).toBe("https://demo.example/r.git");
  expect(items[0].claimSkeleton?.tags).toContainEqual(["d", id]);
  expect(items[0].claimSkeleton?.tags).toContainEqual(["e", id, "", "root"]);
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL — `relays`/`cloneUrl` not on `RepoInput`; `claimSkeleton` not on item.

- [ ] **Step 3: Implement in `src/registry.ts`**

Add the import:

```ts
import { buildClaimEvent, ClaimTemplate } from "./claimEvent";
import { repoClone } from "./nip34"; // add repoClone to the existing nip34 import line
```

Extend `RepoInput` (make new fields optional so existing tests compile):

```ts
export interface RepoInput {
  ref: RepoRef;
  resolved: ResolvedIssue[];
  claimFor?: (issueId: string) => ClaimView | undefined;
  relays?: string[];       // registry-trusted publish targets
  cloneUrl?: string | null; // from the 30617 announcement `clone` tag
}
```

Extend `MultiRepoItem`:

```ts
export type MultiRepoItem = WorklistItem & {
  repo: string;
  relays: string[];
  cloneUrl: string | null;
  claimSkeleton: ClaimTemplate | null; // null when not claimable (no relays / non-hex id)
};
```

In `buildMultiRepoWorklist`, where each item is pushed, attach the fields (HEX64 already defined in this file):

```ts
const relays = r.relays ?? [];
const cloneUrl = r.cloneUrl ?? null;
for (const it of items) {
  const claimSkeleton =
    relays.length && HEX64.test(it.issueId) ? buildClaimEvent(it.issueId, { now: 0 }) : null;
  all.push({ ...it, repo: label, relays, cloneUrl, claimSkeleton });
}
```

In `fetchRepoInput`, populate `relays` + `cloneUrl` from what it already has (the announcement + the resolved relays):

```ts
// after: const announcement = await discoverAnnouncement(ref.owner, ref.d, relays);
const cloneList = repoClone(announcement);
const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;
// ...
return { ref, resolved, claimFor, relays, cloneUrl };
```

(`relays` is the local var already computed at the top of `fetchRepoInput`.)

- [ ] **Step 4: Run, verify pass**

Run: `npm run typecheck && npx vitest run test/registry.test.ts`
Expected: PASS (new test green; existing registry tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "feat(registry): thread relays/cloneUrl/claimSkeleton onto worklist items"
```

---

## Task 5: Render the Claim/Release control, clone affordance, and data attributes

**Files:**
- Modify: `src/webui.ts`
- Test: `test/webui.test.ts`

- [ ] **Step 1: Update the `item()` helper and write failing render tests** (`test/webui.test.ts`)

Update the helper to supply the new required fields:

```ts
function item(over: Partial<MultiRepoItem> = {}): MultiRepoItem {
  return {
    issueId: "a".repeat(64), subject: "Fix a thing", complexity: "M", reasons: [],
    claim: null, repo: "ngit",
    relays: ["wss://relay.one"], cloneUrl: "https://x.example/r.git",
    claimSkeleton: { kind: 31621, created_at: 0,
      tags: [["d", "a".repeat(64)], ["e", "a".repeat(64), "", "root"], ["expiration", "259200"], ["status", "claimed"]],
      content: "" },
    ...over,
  };
}
```

Add tests:

```ts
import { buildClaimEvent } from "../src/claimEvent";

describe("renderWorklistHtml — claim controls", () => {
  it("available row with relays gets a Claim button + data-* (skeleton parity with buildClaimEvent)", () => {
    const id = "d".repeat(64);
    const html = renderWorklistHtml([item({ issueId: id })]);
    expect(html).toMatch(/class="claim-btn"[^>]*data-action="claim"/);
    expect(html).toContain(`data-issue-id="${id}"`);
    expect(html).toContain(`data-relays="wss://relay.one"`);
    // parity: the embedded skeleton's static tags equal buildClaimEvent's
    const want = buildClaimEvent(id, { now: 0 }).tags.filter((t) => t[0] === "d" || t[0] === "e" || t[0] === "status");
    for (const t of want) expect(html).toContain(escapeHtml(JSON.stringify(t)));
  });

  it("claimed row shows the holder label + data-holder; its claim button is present but hidden", () => {
    // The button stays in the DOM (hidden) so the client can reveal it as "Release"
    // for the connected visitor when holder === their pubkey (spec Decision 4).
    const html = renderWorklistHtml([item({ claim: { holder: "f".repeat(64), expiresAt: 2e9, contended: false } })]);
    expect(html).toMatch(/claimed · ffffffff/);
    expect(html).toContain(`data-holder="${"f".repeat(64)}"`);
    expect(html).toMatch(/class="claim-btn"[^>]*hidden/);
  });

  it("no-relays repo renders no claim control", () => {
    const html = renderWorklistHtml([item({ relays: [], claimSkeleton: null })]);
    expect(html).not.toMatch(/claim-btn/);
  });

  it("non-hex id renders no claim control", () => {
    const html = renderWorklistHtml([item({ issueId: "not-hex", claimSkeleton: null })]);
    expect(html).not.toMatch(/claim-btn/);
  });

  it("clone: https → href, nostr → text, javascript → dropped", () => {
    expect(renderWorklistHtml([item({ cloneUrl: "https://ok.example/r.git" })])).toMatch(/href="https:\/\/ok\.example\/r\.git"/);
    expect(renderWorklistHtml([item({ cloneUrl: "nostr://npub1/r" })])).toContain("git clone nostr://npub1/r");
    expect(renderWorklistHtml([item({ cloneUrl: "javascript:alert(1)" })])).not.toMatch(/javascript:alert/);
  });

  it("</script> in a subject cannot break out (XSS via skeleton/text context)", () => {
    const html = renderWorklistHtml([item({ subject: `</script><img src=x onerror=alert(1)>` })]);
    expect(html).not.toContain(`</script><img`);
    expect(html).toContain("&lt;/script&gt;&lt;img");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npx vitest run test/webui.test.ts`
Expected: FAIL — no `claim-btn`, no `data-*`.

- [ ] **Step 3: Update the `row()` function in `src/webui.ts`**

Replace the `row` function with one that emits the control + clone + data attributes. The claim cell keeps the existing label and adds a button when claimable; the row carries `data-*`.

```ts
function controlCell(it: MultiRepoItem): string {
  const relays = claimRelays(it.relays);
  const claimable = it.claimSkeleton !== null && relays.length > 0;
  if (!claimable) return `<td class="act"></td>`;
  // available → Claim; held rows still emit the button hidden, the client reveals "Release"
  const avail = isAvailable(it);
  const hidden = avail ? "" : " hidden";
  return `<td class="act"><button class="claim-btn" data-action="claim"${hidden}>Claim</button></td>`;
}

function cloneCell(it: MultiRepoItem): string {
  if (!it.cloneUrl) return `<td class="clone"></td>`;
  const c = safeClone(it.cloneUrl);
  if (!c) return `<td class="clone"></td>`;
  if (c.kind === "href")
    return `<td class="clone"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">clone</a></td>`;
  return `<td class="clone"><code>git clone ${escapeHtml(c.url)}</code></td>`;
}

function row(it: MultiRepoItem): string {
  const link = issueLink(it.issueId);
  const subj = escapeHtml(it.subject);
  const subjectCell = link ? `<a href="${link}" target="_blank" rel="noopener">${subj}</a>` : subj;
  const avail = isAvailable(it);
  const holder = it.claim?.holder ?? "";
  const relays = claimRelays(it.relays);
  const skeletonAttr = it.claimSkeleton ? ` data-skeleton="${escapeHtml(JSON.stringify(it.claimSkeleton))}"` : "";
  return [
    `<tr data-cx="${it.complexity}" data-repo="${escapeHtml(it.repo)}" data-avail="${avail}"`,
    ` data-issue-id="${escapeHtml(it.issueId)}" data-relays="${escapeHtml(relays.join(","))}"`,
    ` data-holder="${escapeHtml(holder)}"${skeletonAttr}>`,
    `<td class="repo">${escapeHtml(it.repo)}</td>`,
    `<td><span class="badge cx-${it.complexity}">${it.complexity}</span></td>`,
    `<td><span class="claim ${avail ? "open" : "taken"}">${escapeHtml(claimText(it))}</span></td>`,
    `<td class="subject">${subjectCell}</td>`,
    `<td class="id">${escapeHtml(it.issueId.slice(0, 8))}</td>`,
    controlCell(it),
    cloneCell(it),
    `</tr>`,
  ].join("");
}
```

Add the two new column headers in `renderWorklistHtml` (`<thead>`), after the `id` header:

```ts
// change the thead row to:
`<thead><tr><th>repo</th><th>size</th><th>claim</th><th>subject</th><th>id</th><th></th><th></th></tr></thead>`
```

(And update the empty-state `colspan="5"` → `colspan="7"`.)

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run test/webui.test.ts`
Expected: PASS (all render + XSS + parity tests green).

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): render claim/release control, clone link, and data-* attributes"
```

---

## Task 6: WNJ script + inline client handler (the I/O edge)

**Files:**
- Modify: `src/webui.ts`

This task adds browser-only code (signing + publishing). It is **verified live**, not unit-tested — `webui.test.ts` only asserts the script tag/handler are present as strings.

- [ ] **Step 1: Pin WNJ and compute its SRI hash**

```bash
V=$(npm view window.nostr.js version)
echo "pinned: $V"
curl -sL "https://cdn.jsdelivr.net/npm/window.nostr.js@${V}/dist/window.nostr.min.js" \
  | openssl dgst -sha384 -binary | openssl base64 -A
```
Record the printed version `$V` and the `sha384-…` hash; use them in Step 2.

- [ ] **Step 2: Add a string assertion test** (`test/webui.test.ts`)

```ts
it("includes the WNJ signer script (pinned + SRI) and the claim handler", () => {
  const html = renderWorklistHtml([item()]);
  expect(html).toMatch(/window\.nostr\.js@\d+\.\d+\.\d+\/dist\/window\.nostr\.min\.js/);
  expect(html).toContain('integrity="sha384-');
  expect(html).toContain("claim-btn"); // handler wires these
  expect(html).toContain("window.nostr.signEvent");
});
```

Run: `npx vitest run test/webui.test.ts` → FAIL (no WNJ script yet).

- [ ] **Step 3: Add the WNJ script tag + `wnjParams` + the client handler to `renderWorklistHtml`**

In the `<head>` (before `</head>`), add WNJ config + the pinned script (replace `VERSION` and `SRIHASH` with Step 1's values):

```html
<script>window.wnjParams = { position: 'bottom', accent: 'green', startHidden: true, appMetadata: { name: 'PRana' } };</script>
<script src="https://cdn.jsdelivr.net/npm/window.nostr.js@VERSION/dist/window.nostr.min.js" integrity="sha384-SRIHASH" crossorigin="anonymous"></script>
```

Add `import { DEFAULT_TTL_SECONDS } from "./claimEvent";` at the top of `webui.ts` and interpolate `${DEFAULT_TTL_SECONDS}` into the script string for `const TTL`. This is safe: `webui.ts` is a **server-side render module** (it already imports `nostr-tools`' `nip19`) — only its *output string* reaches the browser, so importing a constant doesn't ship anything extra. `webui.ts` stays free of network I/O (a pure function of its input items), which is the property the tests rely on.

Append the handler to the inline `<script>` at the end of the body, after the existing filter code.

Append to the inline script (note: this is the literal JS shipped to the browser):

```js
  const TTL = ${DEFAULT_TTL_SECONDS};
  let pubkey = null;

  function revealReleases() {
    if (!pubkey) return;
    for (const tr of document.querySelectorAll("#rows tr[data-holder]")) {
      if (tr.dataset.holder && tr.dataset.holder.toLowerCase() === pubkey) {
        const b = tr.querySelector(".claim-btn");
        if (b) { b.textContent = "Release"; b.dataset.action = "release"; b.hidden = false; }
      }
    }
  }
  async function ensurePubkey() {
    if (pubkey) return pubkey;
    if (!window.nostr) throw new Error("no signer available");
    pubkey = (await window.nostr.getPublicKey()).toLowerCase();
    revealReleases();
    return pubkey;
  }
  function publish(relays, event) {
    return new Promise((resolve) => {
      let pending = relays.length, ok = false;
      if (!pending) return resolve(false);
      for (const url of relays) {
        let ws; try { ws = new WebSocket(url); } catch { if (--pending === 0) resolve(ok); continue; }
        const done = () => { try { ws.close(); } catch {} if (--pending === 0) resolve(ok); };
        const timer = setTimeout(done, 5000);
        ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
        ws.onmessage = (m) => { try { const d = JSON.parse(m.data);
          if (d[0] === "OK" && d[1] === event.id) { if (d[2] === true) ok = true; clearTimeout(timer); done(); } } catch {} };
        ws.onerror = () => { clearTimeout(timer); done(); };
      }
    });
  }
  async function act(btn) {
    const tr = btn.closest("tr");
    const relays = (tr.dataset.relays || "").split(",").filter(Boolean);
    if (!relays.length || !tr.dataset.skeleton) return;
    const action = btn.dataset.action || "claim";
    const orig = btn.textContent; btn.disabled = true; btn.textContent = "signing…";
    try {
      const pk = await ensurePubkey();
      const sk = JSON.parse(tr.dataset.skeleton);
      const now = Math.floor(Date.now() / 1000);
      const tags = sk.tags.filter((t) => t[0] !== "expiration" && t[0] !== "status")
        .concat([["expiration", String(now + TTL)], ["status", action === "release" ? "released" : "claimed"]]);
      const signed = await window.nostr.signEvent({ kind: sk.kind, created_at: now, tags, content: "" });
      btn.textContent = "publishing…";
      if (!(await publish(relays, signed))) throw new Error("no relay accepted");
      const cell = tr.querySelector(".claim");
      if (action === "release") {
        tr.dataset.holder = ""; tr.dataset.avail = "true";
        if (cell) { cell.textContent = "available"; cell.className = "claim open"; }
        btn.textContent = "Claim"; btn.dataset.action = "claim";
      } else {
        tr.dataset.holder = pk; tr.dataset.avail = "false";
        if (cell) { cell.textContent = "claimed · " + pk.slice(0, 8); cell.className = "claim taken"; }
        btn.textContent = "Release"; btn.dataset.action = "release";
      }
      btn.disabled = false;
    } catch (e) {
      btn.textContent = orig; btn.disabled = false;
      alert("Failed: " + (e && e.message ? e.message : e));
    }
  }
  document.querySelectorAll(".claim-btn").forEach((b) => b.addEventListener("click", () => act(b)));
```

- [ ] **Step 4: Run the string-assertion test + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests green (render asserts WNJ script + handler present).

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): WNJ signer + client claim/release handler (raw-WS publish)"
```

---

## Task 7: Live verification + docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: Serve and verify in a browser**

```bash
npm run serve registry.json
# open http://localhost:8787
```
Verify by observation (record results):
- An available row shows a **Claim** button; a claimed row shows `claimed · …` and no button.
- Click **Claim** → WNJ prompts (NIP-07 extension if present, else NIP-46 QR for Clave) → approve → row flips to **Release** and `claimed · <you>`.
- `npm run registry registry.json` in another shell shows that row as `claimed:<you>`.
- Click **Release** → row flips back to available; `npm run registry` confirms.
- A row whose repo announces an `https` clone URL shows a working **clone** link; a `nostr://` one shows copyable `git clone nostr://…` text.

- [ ] **Step 2: Update `README.md`** — add a short "Claim from the web" note under the Web UI section (the button signs via your own signer through `window.nostr.js`; server stays read-only).

- [ ] **Step 3: Update `CLAUDE.md`** — mark roadmap #5 web UI as having a live claim/release button + clone link; note WNJ as the signer shim and that publish targets are the registry relays.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: web claim/release button + clone link"
```

- [ ] **Step 5: Push** (ngit nostr remote — needs `~/.cargo/bin` on PATH; approve the Clave prompt)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git push origin main
```

---

## Notes for the implementer

- **`webui.ts` boundaries:** it is a server-side render module (already imports `nostr-tools` `nip19`); only its output HTML string reaches the browser. Keep it a pure function of its input items (no network I/O) — that's what the tests rely on. `MultiRepoItem`/`ClaimTemplate` are used as types (erased); `DEFAULT_TTL_SECONDS` is a fine value import. Do **not** add a value import of `registry.ts` (would create a server-only import cycle with no benefit).
- **Single source of truth:** the claim skeleton is built only by `buildClaimEvent` (server side). The client mutates only `created_at`, `expiration`, and `status` — never re-derives `d`/`e`. The parity test (Task 5) guards drift.
- **NIP-40:** release expiry is `now + TTL` (future), never `now`. The client path already does this; do not "optimize" it to `now`.
- **Security invariants (from the adversarial review):** JSON lives only in `data-*` attributes; publish only to `claimRelays(...)`-sanitized registry relays; clone scheme-checked via `new URL().protocol`; flip only on a trusted `OK`.
