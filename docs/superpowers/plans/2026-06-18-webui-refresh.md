# Web worklist UI refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server-rendered web worklist more usable — wide fluid layout, sortable columns, gitworkshop.dev links, sticky header + live count, copy-id button, responsive narrow layout — without touching fetch/resolve/fold/claim behavior.

**Architecture:** All rendering stays in `src/webui.ts` as server-rendered template-string HTML plus one vanilla `<script>` (no framework, no build). The only data-layer change is adding `owner`/`d` to `MultiRepoItem` in `src/registry.ts` so the renderer can build gitworkshop URLs. All gitworkshop URL knowledge lives in `webui.ts`. Every untrusted string stays `escapeHtml`-escaped; URLs are built only from `nip19` bech32 encodings + `new URL().host`.

**Tech Stack:** TypeScript, `nostr-tools` (`nip19.npubEncode` / `neventEncode`), vitest. Spec: `docs/superpowers/specs/2026-06-18-webui-refresh-design.md`. Conventions: TDD (failing test first), minimal diffs, all tests stay green (144 at baseline on `feat/webui-refresh`), frequent commits.

**Review level:** targeted security pass — adversarial XSS/`href`-injection tests are part of TDD (Tasks 2–3); `/security-review` runs on the final diff before merge. The signer/claim-publish path is out of scope and unchanged.

---

## File Structure

- `src/registry.ts` — `MultiRepoItem` gains `owner: string` and `d: string`; `buildMultiRepoWorklist` populates them from `r.ref`. Nothing else changes.
- `src/webui.ts` — the bulk: two pure gitworkshop URL builders, a rewritten `row()` (links + copy button + `data-label`s, njump removed), wider `max-width`, sortable `thead` + sort script, sticky header + live count, responsive `@media` block.
- `test/registry.test.ts` — assert items expose `owner`/`d`.
- `test/webui.test.ts` — update the `item()` factory (add `owner`/`d`), swap njump assertions for gitworkshop, add the adversarial URL/`href` tests, sortable/sticky/count/copy/responsive markup assertions.

---

## Task 1: Plumb `owner` + `d` onto `MultiRepoItem`

**Files:**
- Modify: `src/registry.ts` (the `MultiRepoItem` type + the `buildMultiRepoWorklist` push)
- Modify: `test/webui.test.ts` (the `item()` factory — keep typecheck green once `owner`/`d` are required)
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/registry.test.ts`, at the end of the `describe("buildMultiRepoWorklist — relays/cloneUrl/claimSkeleton threading", …)` block (it already builds a `RepoInput` with `ref.owner`/`ref.d`):

```typescript
  it("carries the repo owner + d coordinate onto each item (for gitworkshop links)", async () => {
    const input: RepoInput = {
      ref: { owner: "1".repeat(64), d: "demo", name: "demo" },
      relays: ["wss://relay.one"],
      resolved: [{
        issue: { id: "a".repeat(64), pubkey: "2".repeat(64), created_at: 1, kind: 1621, tags: [["subject", "x"]], content: "" },
        state: "open", decidedBy: null, ambiguousTimestamp: false, forkSignal: null,
      }],
    };
    const items = await buildMultiRepoWorklist([input]);
    expect(items[0].owner).toBe("1".repeat(64));
    expect(items[0].d).toBe("demo");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/registry.test.ts -t "gitworkshop links"`
Expected: FAIL — `items[0].owner` is `undefined` (and `npm run typecheck` would flag `owner`/`d` missing once the type requires them; we add the field next).

- [ ] **Step 3: Add `owner`/`d` to the type and populate them**

In `src/registry.ts`, extend the `MultiRepoItem` type:

```typescript
/** A worklist row tagged with the repo it came from. */
export type MultiRepoItem = WorklistItem & {
  repo: string;
  owner: string; // 30617 announcement author pubkey (for gitworkshop npub link)
  d: string; // repo identifier
  relays: string[];
  cloneUrl: string | null;
  claimSkeleton: ClaimTemplate | null; // null when not claimable (no relays / non-hex id)
};
```

In `buildMultiRepoWorklist`, add `owner`/`d` to the push (currently `all.push({ ...it, repo: label, relays, cloneUrl, claimSkeleton })`):

```typescript
      all.push({ ...it, repo: label, owner: r.ref.owner, d: r.ref.d, relays, cloneUrl, claimSkeleton });
```

- [ ] **Step 4: Update the test `item()` factory so typecheck stays green**

In `test/webui.test.ts`, the `item()` factory returns a `MultiRepoItem` literal. Add `owner`/`d` defaults (valid 64-hex owner so later gitworkshop tests can build a URL):

```typescript
    repo: "ngit",
    owner: "1".repeat(64),
    d: "ngit",
    relays: ["wss://relay.one"], cloneUrl: "https://x.example/r.git",
```

(Insert the two lines between `repo: "ngit",` and the `relays:` line.)

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `npx vitest run test/registry.test.ts test/webui.test.ts && npm run typecheck`
Expected: PASS (the new registry test passes; webui tests unaffected; typecheck clean — no missing-property errors).

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/registry.test.ts test/webui.test.ts
git commit -m "feat(registry): carry repo owner+d onto MultiRepoItem for gitworkshop links"
```

---

## Task 2: gitworkshop.dev URL builders (pure) + adversarial tests

**Files:**
- Modify: `src/webui.ts` (add two exported functions near the existing `issueLink`)
- Test: `test/webui.test.ts`

Verified formats (from live pages, round-trip-confirmed with `nostr-tools`):
`repo = https://gitworkshop.dev/<npub>/<relay-host>/<d>`, `issue = <repo>/issues/<nevent>` where `nevent = neventEncode({ id, relays: [firstRelay] })`.

- [ ] **Step 1: Write the failing tests**

Add to `test/webui.test.ts`. First extend the import on line 2 to add the two new functions (keep `issueLink` for now — Task 3 removes it):

```typescript
import { renderWorklistHtml, escapeHtml, issueLink, claimRelays, safeClone, gitworkshopRepoUrl, gitworkshopIssueUrl } from "../src/webui";
```

Then add this describe block:

```typescript
describe("gitworkshop URL builders", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";
  const NPUB = "npub1xy54p83r6wnpyhs52xjeztd7qyyeu9ghymz8v66yu8kt3jzx75rqhf3urc";

  it("builds the exact verified prana repo + issue URLs", () => {
    const repo = gitworkshopRepoUrl(OWNER, "prana", ["wss://relay.ngit.dev"]);
    expect(repo).toBe(`https://gitworkshop.dev/${NPUB}/relay.ngit.dev/prana`);
    const issue = gitworkshopIssueUrl(repo, "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf", ["wss://relay.ngit.dev"]);
    expect(issue).toBe(`https://gitworkshop.dev/${NPUB}/relay.ngit.dev/prana/issues/nevent1qy28wumn8ghj7un9d3shjtnwva5hgtnyv4mqqg9vy47mdxf447s4rw50r98v8aecgk65xtjddwddrz3r6wxjvqlleuca4xlq`);
  });

  it("ADVERSARIAL: returns null on a non-hex owner, empty relays, or hostile relay", () => {
    expect(gitworkshopRepoUrl("not-hex", "prana", ["wss://relay.one"])).toBeNull();
    expect(gitworkshopRepoUrl(OWNER, "prana", [])).toBeNull();
    expect(gitworkshopRepoUrl(OWNER, "prana", ["javascript:alert(1)"])).toBeNull(); // host === ""
    expect(gitworkshopRepoUrl(OWNER, "prana", ["not a url"])).toBeNull(); // new URL throws
  });

  it("ADVERSARIAL: a hostile d is percent-encoded and never breaks the URL", () => {
    const url = gitworkshopRepoUrl(OWNER, 'a/../b"<x>', ["wss://relay.one"])!;
    expect(url.startsWith("https://gitworkshop.dev/")).toBe(true);
    expect(url).not.toContain('"');
    expect(url).not.toContain("<");
    expect(url.endsWith("/a%2F..%2Fb%22%3Cx%3E")).toBe(true);
  });

  it("ADVERSARIAL: issue URL is null for a null repo or a non-hex id", () => {
    expect(gitworkshopIssueUrl(null, "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf", ["wss://relay.one"])).toBeNull();
    expect(gitworkshopIssueUrl("https://gitworkshop.dev/x/y/z", "not-hex", ["wss://relay.one"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webui.test.ts -t "gitworkshop URL builders"`
Expected: FAIL — `gitworkshopRepoUrl`/`gitworkshopIssueUrl` are not exported.

- [ ] **Step 3: Implement the builders**

In `src/webui.ts`, add immediately after the `issueLink` function (around line 56):

```typescript
const GITWORKSHOP = "https://gitworkshop.dev";

/** gitworkshop.dev repo page, or null if it can't be built safely.
 *  Format (verified live): https://gitworkshop.dev/<npub>/<relay-host>/<d>.
 *  Built only from a bech32 npub + new URL().host + an encoded d — no untrusted
 *  string reaches the URL un-encoded, so the result is always a gitworkshop https URL. */
export function gitworkshopRepoUrl(owner: string, d: string, relays: string[]): string | null {
  if (!relays.length) return null;
  let host: string;
  try { host = new URL(relays[0]).host; } catch { return null; }
  if (!host) return null; // e.g. a `javascript:` "relay" parses but has no host
  let npub: string;
  try { npub = nip19.npubEncode(owner); } catch { return null; }
  return `${GITWORKSHOP}/${npub}/${host}/${encodeURIComponent(d)}`;
}

/** gitworkshop.dev issue page, or null. Format: <repoUrl>/issues/<nevent>, where the
 *  nevent carries the issue's first relay hint (matches gitworkshop's own encoding). */
export function gitworkshopIssueUrl(repoUrl: string | null, issueId: string, relays: string[]): string | null {
  if (!repoUrl) return null;
  let nevent: string;
  try { nevent = nip19.neventEncode({ id: issueId, relays: relays.slice(0, 1) }); } catch { return null; }
  return `${repoUrl}/issues/${nevent}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/webui.test.ts -t "gitworkshop URL builders" && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): add gitworkshop repo/issue URL builders (verified format, adversarial-tested)"
```

---

## Task 3: Rewrite `row()` — gitworkshop links, copy-id, data-labels; drop njump

**Files:**
- Modify: `src/webui.ts` (`row()`, `cloneCell()`, remove `issueLink`, add the copy handler to the inline script)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write/adjust the failing tests**

In `test/webui.test.ts`:

(a) Remove `issueLink` from the import on line 2:

```typescript
import { renderWorklistHtml, escapeHtml, claimRelays, safeClone, gitworkshopRepoUrl, gitworkshopIssueUrl } from "../src/webui";
```

(b) Delete the two njump tests: the `it("encodes a valid 64-hex id to an njump note link", …)` and `it("returns null for an id that isn't a valid event id", …)` cases inside `describe("escapeHtml / issueLink", …)`, and the `it("links a real issue id to njump", …)` case inside `describe("renderWorklistHtml", …)`. (Keep the `escapeHtml` test; rename that describe to `describe("escapeHtml", …)`.)

(c) Add this describe block:

```typescript
describe("renderWorklistHtml — gitworkshop links + copy-id (Task 3)", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";

  it("links the repo name and the subject to gitworkshop.dev", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", repo: "prana", issueId: "a".repeat(64), relays: ["wss://relay.ngit.dev"] })]);
    expect(html).toMatch(/href="https:\/\/gitworkshop\.dev\/npub1[0-9a-z]+\/relay\.ngit\.dev\/prana"/); // repo link
    expect(html).toMatch(/href="https:\/\/gitworkshop\.dev\/npub1[0-9a-z]+\/relay\.ngit\.dev\/prana\/issues\/nevent1[0-9a-z]+"/); // issue link
    expect(html).not.toContain("njump.me"); // njump dropped
  });

  it("renders a copy-id button with an aria-label", () => {
    const html = renderWorklistHtml([item()]);
    expect(html).toMatch(/class="copy-id"[^>]*aria-label="Copy full issue id"/);
  });

  it("ADVERSARIAL: never emits a non-gitworkshop href from row data (no javascript:, no break-out)", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: 'a"/<x>', repo: 'r"<x>', subject: `</a><img src=x onerror=alert(1)>`, relays: ["wss://relay.ngit.dev"] })]);
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody).not.toMatch(/href="javascript:/i);
    // every href in the row body is a gitworkshop https URL
    for (const m of tbody.matchAll(/href="([^"]*)"/g)) {
      expect(m[1].startsWith("https://gitworkshop.dev/") || m[1].startsWith("https://x.example/")).toBe(true); // gitworkshop or the clone url
    }
    expect(tbody).toContain("&lt;img"); // the hostile subject is escaped as text
  });

  it("falls back to plain text (no link) when relays are missing or id is non-hex", () => {
    const noRelays = renderWorklistHtml([item({ relays: [], claimSkeleton: null })]);
    const tbody1 = noRelays.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody1).not.toContain("gitworkshop.dev"); // no repo/issue link without relays
    const badId = renderWorklistHtml([item({ issueId: "not-hex", claimSkeleton: null })]);
    const tbody2 = badId.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody2).not.toMatch(/\/issues\/nevent/); // no issue link for a non-hex id
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webui.test.ts`
Expected: FAIL — `row()` still emits njump and has no copy button; the new gitworkshop/copy/adversarial tests fail. (Compile may also fail because `issueLink` is still referenced inside `row()` while removed from the import in the test — that's fine, we fix `row()` next.)

- [ ] **Step 3: Rewrite `row()`, update `cloneCell()`, remove `issueLink`**

In `src/webui.ts`, delete the `issueLink` function (the `/** Deep-link an issue to njump … */` block and the `export function issueLink(...) { … }`).

Replace the whole `row()` function with:

```typescript
function row(it: MultiRepoItem): string {
  const repoUrl = gitworkshopRepoUrl(it.owner, it.d, it.relays);
  const issueUrl = gitworkshopIssueUrl(repoUrl, it.issueId, it.relays);
  const repoLabel = escapeHtml(it.repo);
  const repoCell = repoUrl
    ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${repoLabel}</a>`
    : repoLabel;
  const subj = escapeHtml(it.subject);
  const subjectCell = issueUrl
    ? `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener">${subj}</a>`
    : subj;
  const avail = isAvailable(it);
  const holder = it.claim?.holder ?? "";
  const relays = claimRelays(it.relays);
  const skeletonAttr = it.claimSkeleton ? ` data-skeleton="${escapeHtml(JSON.stringify(it.claimSkeleton))}"` : "";
  return [
    `<tr data-cx="${it.complexity}" data-repo="${escapeHtml(it.repo)}" data-avail="${avail}"`,
    ` data-issue-id="${escapeHtml(it.issueId)}" data-relays="${escapeHtml(relays.join(","))}"`,
    ` data-holder="${escapeHtml(holder)}"${skeletonAttr}>`,
    `<td class="repo" data-label="repo">${repoCell}</td>`,
    `<td data-label="size"><span class="badge cx-${it.complexity}">${it.complexity}</span></td>`,
    `<td data-label="claim"><span class="claim ${avail ? "open" : "taken"}">${escapeHtml(claimText(it))}</span></td>`,
    `<td class="subject" data-label="subject">${subjectCell}</td>`,
    `<td class="id" data-label="id"><span class="idtext">${escapeHtml(it.issueId.slice(0, 8))}</span><button class="copy-id" type="button" aria-label="Copy full issue id" title="Copy full issue id">⧉</button></td>`,
    controlCell(it),
    cloneCell(it),
    `</tr>`,
  ].join("");
}
```

Update `cloneCell()` to add a `data-label` (for the responsive view) — change each returned `<td class="clone"…` to include `data-label="clone"`:

```typescript
function cloneCell(it: MultiRepoItem): string {
  if (!it.cloneUrl) return `<td class="clone" data-label="clone"></td>`;
  const c = safeClone(it.cloneUrl);
  if (!c) return `<td class="clone" data-label="clone"></td>`;
  if (c.kind === "href")
    return `<td class="clone" data-label="clone"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">clone</a></td>`;
  return `<td class="clone" data-label="clone"><code>git clone ${escapeHtml(c.url)}</code></td>`;
}
```

Add the copy handler to the inline `<script>` — insert just before the final `document.querySelectorAll(".claim-btn")…` line:

```javascript
  document.querySelectorAll(".copy-id").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest("tr").dataset.issueId;
    if (!id || !navigator.clipboard) return;
    navigator.clipboard.writeText(id).then(() => {
      const t = b.textContent; b.textContent = "✓";
      setTimeout(() => { b.textContent = t; }, 1000);
    }).catch(() => {});
  }));
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run test/webui.test.ts && npm run typecheck`
Expected: PASS — gitworkshop links present, njump gone, copy button present, adversarial hrefs contained, fallbacks plain text. The existing claim-control and escaping tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): link rows to gitworkshop, add copy-id, drop njump (adversarial-tested)"
```

---

## Task 4: Wide fluid layout (kill the deadspace)

**Files:**
- Modify: `src/webui.ts` (the `body` CSS rule in the `<style>` block)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/webui.test.ts`:

```typescript
describe("renderWorklistHtml — wide layout (Task 4)", () => {
  it("uses a 1200px max-width, not the old 960px", () => {
    const html = renderWorklistHtml([item()]);
    expect(html).toMatch(/max-width:\s*1200px/);
    expect(html).not.toMatch(/max-width:\s*960px/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webui.test.ts -t "wide layout"`
Expected: FAIL — the page still says `max-width: 960px`.

- [ ] **Step 3: Implement**

In `src/webui.ts`, in the `<style>` block, change the `body` rule's `max-width: 960px` to `max-width: 1200px`:

```css
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; padding: 1.5rem; max-width: 1200px; }
```

(Note `margin: 0` → `margin: 0 auto` so the wider content stays centered.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webui.test.ts -t "wide layout"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): widen worklist to 1200px to remove right-side deadspace"
```

---

## Task 5: Sortable column headers

**Files:**
- Modify: `src/webui.ts` (the `<thead>` markup, the `<style>` block, and the inline `<script>`)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/webui.test.ts`:

```typescript
describe("renderWorklistHtml — sortable headers (Task 5)", () => {
  it("makes repo/size/claim/subject sortable and leaves id/action/clone plain", () => {
    const html = renderWorklistHtml([item()]);
    for (const key of ["repo", "size", "claim", "subject"]) {
      expect(html).toContain(`data-sort="${key}"`);
    }
    expect(html).toMatch(/class="sort"[^>]*aria-sort="none"/);
    // exactly four sortable columns
    expect((html.match(/data-sort=/g) ?? []).length).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webui.test.ts -t "sortable headers"`
Expected: FAIL — headers are plain `<th>` with no `data-sort`.

- [ ] **Step 3: Implement**

In `src/webui.ts`, replace the `<thead>` line:

```html
    <thead><tr><th>repo</th><th>size</th><th>claim</th><th>subject</th><th>id</th><th></th><th></th></tr></thead>
```

with:

```html
    <thead><tr>
      <th><button class="sort" type="button" data-sort="repo" aria-sort="none">repo<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="size" aria-sort="none">size<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="claim" aria-sort="none">claim<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="subject" aria-sort="none">subject<span class="arr" aria-hidden="true"></span></button></th>
      <th>id</th><th></th><th></th>
    </tr></thead>
```

Add to the `<style>` block (after the `th, td` rule):

```css
  th button.sort { font: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; color: inherit; text-transform: inherit; letter-spacing: inherit; display: inline-flex; align-items: center; gap: .25rem; }
  th button.sort .arr::after { content: ""; font-size: .7em; opacity: .7; }
  th button.sort[aria-sort="ascending"] .arr::after { content: "▲"; }
  th button.sort[aria-sort="descending"] .arr::after { content: "▼"; }
```

Add to the inline `<script>`, after the line `const rows = [...document.querySelectorAll("#rows tr[data-cx]")];`:

```javascript
  const tbody = document.getElementById("rows");
  const CX = { S: 0, M: 1, L: 2 };
  const sortState = { key: null, dir: 1 };
  function sortKey(tr, key) {
    if (key === "size") return CX[tr.dataset.cx] ?? 99;
    if (key === "claim") return tr.dataset.avail === "true" ? 0 : 1; // available first
    if (key === "subject") return (tr.querySelector(".subject")?.textContent || "").toLowerCase();
    return (tr.dataset.repo || "").toLowerCase(); // "repo"
  }
  function sortBy(key) {
    sortState.dir = sortState.key === key ? -sortState.dir : 1;
    sortState.key = key;
    const sorted = [...tbody.querySelectorAll("tr[data-cx]")].sort((a, b) => {
      const ka = sortKey(a, key), kb = sortKey(b, key);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sortState.dir;
    });
    for (const r of sorted) tbody.appendChild(r);
    document.querySelectorAll("button.sort").forEach((b) =>
      b.setAttribute("aria-sort", b.dataset.sort === key ? (sortState.dir === 1 ? "ascending" : "descending") : "none"));
  }
  document.querySelectorAll("button.sort").forEach((b) => b.addEventListener("click", () => sortBy(b.dataset.sort)));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webui.test.ts -t "sortable headers" && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): sortable repo/size/claim/subject headers (size sorts S→M→L)"
```

---

## Task 6: Sticky header + live "showing N of M"

**Files:**
- Modify: `src/webui.ts` (the `<style>` block, the summary/controls markup, the inline `<script>`'s `apply()`)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/webui.test.ts`:

```typescript
describe("renderWorklistHtml — sticky header + live count (Task 6)", () => {
  it("makes the header sticky and seeds a 'showing N of M' counter", () => {
    const html = renderWorklistHtml([item({ issueId: "a".repeat(64) }), item({ issueId: "b".repeat(64) })]);
    expect(html).toMatch(/thead th\s*{[^}]*position:\s*sticky/);
    expect(html).toContain('id="count"');
    expect(html).toMatch(/showing 2 of 2/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webui.test.ts -t "sticky header"`
Expected: FAIL — no sticky rule, no `#count`.

- [ ] **Step 3: Implement**

In `src/webui.ts` `<style>` block, add a sticky rule (after the `th, td` rule):

```css
  thead th { position: sticky; top: 0; background: Canvas; }
  .count { opacity: .7; font-size: .85rem; margin-left: auto; }
```

In the markup, add a count element to the `.controls` div — change the closing of the controls block from:

```html
    <label class="av"><input type="checkbox" id="avail"/> available only</label>
  </div>
```

to:

```html
    <label class="av"><input type="checkbox" id="avail"/> available only</label>
    <span class="count" id="count">showing ${items.length} of ${items.length}</span>
  </div>
```

In the inline `<script>`, add a count updater and call it from `apply()`. Add this function right after the `rows` declaration:

```javascript
  const countEl = document.getElementById("count");
  function updateCount() {
    const visible = rows.filter((r) => r.style.display !== "none").length;
    if (countEl) countEl.textContent = `showing ${visible} of ${rows.length}`;
  }
```

And add `updateCount();` as the last line inside the existing `apply()` function (just before its closing brace).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webui.test.ts -t "sticky header" && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): sticky table header + live 'showing N of M' filter count"
```

---

## Task 7: Responsive narrow-screen layout (< 640px)

**Files:**
- Modify: `src/webui.ts` (the `<style>` block — add a media query; cells already carry `data-label` from Task 3)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/webui.test.ts`:

```typescript
describe("renderWorklistHtml — responsive (Task 7)", () => {
  it("has a <640px media query and labelled cells for the stacked layout", () => {
    const html = renderWorklistHtml([item()]);
    expect(html).toMatch(/@media\s*\(max-width:\s*640px\)/);
    expect(html).toContain('data-label="repo"');
    expect(html).toContain('data-label="subject"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/webui.test.ts -t "responsive"`
Expected: FAIL — no media query (the `data-label`s already exist from Task 3, but the assertion fails on the missing `@media`).

- [ ] **Step 3: Implement**

In `src/webui.ts`, append this media query at the end of the `<style>` block (just before `</style>`):

```css
  @media (max-width: 640px) {
    body { padding: .75rem; }
    thead { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tr { border: 1px solid #8884; border-radius: 8px; margin-bottom: .6rem; padding: .3rem .2rem; }
    td { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; border: none; padding: .25rem .5rem; }
    td::before { content: attr(data-label); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
    td.subject { flex-direction: column; align-items: flex-start; gap: .1rem; }
    td:empty { display: none; }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/webui.test.ts -t "responsive" && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): responsive stacked layout below 640px"
```

---

## Final verification (after all tasks)

- [ ] **Full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: ALL tests pass (144 baseline + the new tests; ≈ 144 minus 3 removed njump tests plus ~10 added), typecheck clean.

- [ ] **Live verification** — `npm run serve registry.json`, open `http://localhost:8787/`, and confirm:
  - No right-side deadspace at desktop width.
  - Clicking `repo`/`size`/`claim`/`subject` headers re-sorts (size goes S→M→L, not alphabetical); arrow + `aria-sort` flip on repeat clicks.
  - Repo name opens the gitworkshop repo page; subject opens the gitworkshop issue page (compare against `https://gitworkshop.dev/npub1xy54…/relay.ngit.dev/prana`).
  - Copy-id button puts the full hex on the clipboard (paste to check).
  - "showing N of M" updates as size/repo/available filters change.
  - Narrow the window to phone width: the table stacks into labelled cards, no horizontal scroll.

- [ ] **Security review** — run `/security-review` on the branch diff (`git diff main...HEAD`), focused on the new untrusted-string → `href`/URL construction in `row()` + the gitworkshop builders. Address any findings before merge.

- [ ] **Finish** — use superpowers:finishing-a-development-branch. Merge `feat/webui-refresh` → `main`. Pushing prompts the Clave signer and needs `~/.cargo/bin` on PATH — pause and ask the maintainer before pushing.

---

## Self-Review

- **Spec coverage:** wide layout → Task 4; sortable headers → Task 5; sticky + live count → Task 6; copy-id → Task 3; responsive → Task 7; gitworkshop repo+issue links (njump dropped) → Tasks 2–3; `owner`/`d` plumbing → Task 1; adversarial XSS/href tests → Tasks 2–3; `/security-review` → Final. Out-of-scope items (tooltip, B/C layouts, signer path, age column) are not implemented. All covered.
- **Type consistency:** `gitworkshopRepoUrl(owner, d, relays)` and `gitworkshopIssueUrl(repoUrl, issueId, relays)` are defined in Task 2 and used with the same signatures in Task 3. `MultiRepoItem.owner`/`.d` defined in Task 1 and consumed in Task 3. The inline-script identifiers (`rows`, `tbody`, `apply`, `updateCount`, `sortBy`) are introduced once and reused consistently.
- **Placeholder scan:** none — every code step has complete code and exact anchors.
- **Behavior-unchanged check:** the claim/release skeleton-sign-publish flow, `buildClaimEvent`, the folds, fetch/resolve, the unreachable banner, and `safeClone` are untouched; `buildMultiRepoWorklist` only gains two passthrough fields (sort order unchanged).
