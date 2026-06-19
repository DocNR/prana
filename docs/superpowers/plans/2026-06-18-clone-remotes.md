# Clone remotes (ngit + mirror) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the worklist's single clone link with two intent-framed copy chips — an `ngit` (`nostr://…`) clone and a conventional mirror (github/codeberg) — so a contributor can pick their contribution path.

**Architecture:** All rendering stays in `src/webui.ts` (server-rendered string HTML + one inline `<script>`). Extract a shared `repoCoordPath` behind `gitworkshopRepoUrl` and a new `ngitCloneUrl`; pick the mirror in `src/registry.ts` via a pure helper; rewrite `cloneCell` to render two `<button class="clone-chip" data-copy>` chips handled by a generic `[data-copy]` clipboard listener. No fetch/resolve/fold/signer changes.

**Tech Stack:** TypeScript, `nostr-tools` (`nip19`), vitest. Spec: `docs/superpowers/specs/2026-06-18-clone-remotes-design.md`. Conventions: TDD (failing test first), minimal diffs, all tests stay green (159 at baseline on `feat/clone-remotes`), frequent commits.

**Security:** the ngit URL is built only from a validated npub + `wss:` host + encoded `d`; the mirror is gated to http/https via `safeClone`; commands are rendered only as `escapeHtml`'d `data-copy`/`title`/`aria-label` text and written to the clipboard as plain text — no `href`, no scheme injection.

---

## File Structure

- `src/webui.ts` — extract private `repoCoordPath`; refactor `gitworkshopRepoUrl` to use it (behavior-preserving); add exported `ngitCloneUrl`; add `mirrorLabel` + `cloneChip` helpers; rewrite `cloneCell` to render two chips; add a generic `[data-copy]` clipboard listener to the inline `<script>`; add `.clone-chip` CSS.
- `src/registry.ts` — add exported `pickMirrorClone(cloneList)`; use it in `fetchRepoInput`.
- `test/webui.test.ts` — `ngitCloneUrl` unit/adversarial tests; clone-chip rendering tests (replacing the old single-clone test).
- `test/registry.test.ts` — `pickMirrorClone` tests.

---

## Task 1: Shared `repoCoordPath` + `ngitCloneUrl`

**Files:**
- Modify: `src/webui.ts:49-67` (`GITWORKSHOP` const + `gitworkshopRepoUrl`)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/webui.test.ts`, add `ngitCloneUrl` to the import on line 2 (alongside the existing webui imports):

```typescript
import { renderWorklistHtml, escapeHtml, claimRelays, safeClone, gitworkshopRepoUrl, gitworkshopIssueUrl, ngitCloneUrl } from "../src/webui";
```

Add this describe block:

```typescript
describe("ngitCloneUrl", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";
  const NPUB = "npub1xy54p83r6wnpyhs52xjeztd7qyyeu9ghymz8v66yu8kt3jzx75rqhf3urc";

  it("builds the verified nostr:// clone coordinate (matches the maintainer's own remote)", () => {
    expect(ngitCloneUrl(OWNER, "prana", ["wss://relay.ngit.dev"])).toBe(`nostr://${NPUB}/relay.ngit.dev/prana`);
  });

  it("ADVERSARIAL: null on non-hex owner, empty relays, non-wss relay, or junk relay", () => {
    expect(ngitCloneUrl("not-hex", "prana", ["wss://relay.ngit.dev"])).toBeNull();
    expect(ngitCloneUrl(OWNER, "prana", [])).toBeNull();
    expect(ngitCloneUrl(OWNER, "prana", ["https://relay.ngit.dev"])).toBeNull();
    expect(ngitCloneUrl(OWNER, "prana", ["not a url"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webui.test.ts -t "ngitCloneUrl"`
Expected: FAIL — `ngitCloneUrl` is not exported.

- [ ] **Step 3: Implement (extract `repoCoordPath`, refactor `gitworkshopRepoUrl`, add `ngitCloneUrl`)**

In `src/webui.ts`, replace the current `gitworkshopRepoUrl` (lines 51-67, the doc comment through the closing brace) with:

```typescript
/** The shared `<npub>/<relay-host>/<d>` coordinate path, or null if unbuildable.
 *  owner must be 64-hex; relays[0] must be a wss: URL. Host is hostname-encoded
 *  (+ literal port); d is percent-encoded. No untrusted string reaches the result
 *  un-encoded — callers prefix a fixed scheme. */
function repoCoordPath(owner: string, d: string, relays: string[]): string | null {
  if (!/^[0-9a-f]{64}$/i.test(owner)) return null; // a wrong-length pubkey still npub-encodes → reject it, no dead link
  if (!relays.length) return null;
  let host: string;
  try {
    const u = new URL(relays[0]);
    if (u.protocol !== "wss:") return null; // enforce wss: (consistent with claimRelays); blocks http:/javascript:/etc.
    host = encodeURIComponent(u.hostname) + (u.port ? `:${u.port}` : "");
  } catch { return null; }
  let npub: string;
  try { npub = nip19.npubEncode(owner); } catch { return null; }
  return `${npub}/${host}/${encodeURIComponent(d)}`;
}

/** gitworkshop.dev repo page, or null. Format (verified live):
 *  https://gitworkshop.dev/<npub>/<relay-host>/<d>. */
export function gitworkshopRepoUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p ? `${GITWORKSHOP}/${p}` : null;
}

/** ngit-native clone URL: `git clone <this>` wires up the nostr remote (needs ngit),
 *  so a PR lands back on nostr where PRana's worklist/claims live. Same coordinate as
 *  the gitworkshop link / the maintainer's own push remote. null if unbuildable. */
export function ngitCloneUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p ? `nostr://${p}` : null;
}
```

(`gitworkshopIssueUrl`, just below, is unchanged.)

- [ ] **Step 4: Run tests to verify they pass — and that gitworkshop is unchanged**

Run: `npx vitest run test/webui.test.ts -t "ngitCloneUrl" && npx vitest run test/webui.test.ts -t "gitworkshop URL builders" && npm run typecheck`
Expected: PASS — including the existing `it("builds the exact verified prana repo + issue URLs", …)` (the refactor is byte-for-byte behavior-preserving), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): add ngitCloneUrl (shared repoCoordPath with gitworkshopRepoUrl)"
```

---

## Task 2: Mirror selection — `pickMirrorClone`

**Files:**
- Modify: `src/registry.ts` (add `pickMirrorClone`; use it in `fetchRepoInput` where `cloneUrl` is computed, currently `const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;`)
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/registry.test.ts`, add `pickMirrorClone` to the import from `../src/registry`, then add:

```typescript
describe("pickMirrorClone — conventional mirror vs grasp server", () => {
  it("picks the conventional mirror, skipping grasp (npub-embedding) URLs", () => {
    expect(pickMirrorClone(["https://github.com/o/r.git", "https://relay.ngit.dev/npub1abc/r.git"]))
      .toBe("https://github.com/o/r.git");
  });
  it("skips a grasp URL even when it is listed first", () => {
    expect(pickMirrorClone(["https://relay.ngit.dev/npub1abc/r.git", "https://codeberg.org/o/r.git"]))
      .toBe("https://codeberg.org/o/r.git");
  });
  it("returns null when every clone URL is a grasp server", () => {
    expect(pickMirrorClone(["https://relay.ngit.dev/npub1abc/r.git", "https://gitnostr.com/npub1abc/r.git"]))
      .toBeNull();
  });
  it("returns null for an empty list", () => {
    expect(pickMirrorClone([])).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/registry.test.ts -t "pickMirrorClone"`
Expected: FAIL — `pickMirrorClone` is not exported.

- [ ] **Step 3: Implement**

In `src/registry.ts`, add this exported function (place it just above `fetchRepoInput`):

```typescript
/** The conventional mirror clone URL (github/codeberg/…): the first http(s) clone
 *  URL that isn't a grasp server. Grasp clone URLs embed the owner npub in their
 *  path (…/npub1…/repo.git); conventional mirrors don't. null when there's none. */
export function pickMirrorClone(cloneList: string[]): string | null {
  return cloneList.find((u) => /^https?:\/\//.test(u) && !u.includes("/npub1")) ?? null;
}
```

Then in `fetchRepoInput`, replace the `cloneUrl` line:

```typescript
// before:
const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;
// after:
const cloneUrl = pickMirrorClone(cloneList);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/registry.test.ts -t "pickMirrorClone" && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "feat(registry): pick the conventional mirror clone URL, skipping grasp servers"
```

---

## Task 3: Clone cell → two copy chips

**Files:**
- Modify: `src/webui.ts` (`cloneCell` at lines 98-105; add `mirrorLabel`/`cloneChip` helpers; add `.clone-chip` CSS to the `<style>` block; add a `[data-copy]` listener to the inline `<script>`)
- Test: `test/webui.test.ts`

- [ ] **Step 1: Write/adjust the failing tests**

In `test/webui.test.ts`:

(a) DELETE the existing test `it("clone: https → href, nostr → text, javascript → dropped", …)` inside `describe("renderWorklistHtml — claim controls", …)` — it asserts the old single-clone-link behavior, which this task replaces.

(b) Add this describe block:

```typescript
describe("renderWorklistHtml — clone chips (Task 3)", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";
  const cloneTd = (html: string) => html.match(/<td class="clone"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? "";

  it("renders an ngit chip and a host-labelled mirror chip", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", relays: ["wss://relay.ngit.dev"], cloneUrl: "https://github.com/DocNR/prana.git" })]);
    expect(html).toMatch(/data-copy="git clone nostr:\/\/npub1[a-z0-9]+\/relay\.ngit\.dev\/prana"/);
    expect(html).toMatch(/data-copy="git clone https:\/\/github\.com\/DocNR\/prana\.git"/);
    expect(html).toContain(">ngit</button>");   // ngit chip label
    expect(html).toContain(">github</button>"); // mirror chip label (host SLD)
  });

  it("shows only the ngit chip when there is no mirror", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", relays: ["wss://relay.ngit.dev"], cloneUrl: null })]);
    expect(html).toMatch(/git clone nostr:/);
    expect(html).not.toMatch(/git clone https:/);
  });

  it("shows only the mirror chip when relays are missing (no ngit URL)", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", relays: [], cloneUrl: "https://github.com/DocNR/prana.git", claimSkeleton: null })]);
    expect(html).not.toMatch(/git clone nostr:/);
    expect(html).toMatch(/git clone https:\/\/github\.com/);
  });

  it("empty clone cell when neither is buildable", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", relays: [], cloneUrl: null, claimSkeleton: null })]);
    expect(cloneTd(html).trim()).toBe("");
  });

  it("ADVERSARIAL: a hostile mirror scheme is dropped and nothing breaks out", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", relays: ["wss://relay.ngit.dev"], cloneUrl: "javascript:alert(1)" })]);
    expect(html).not.toContain("javascript:alert");
    expect((cloneTd(html).match(/clone-chip/g) ?? []).length).toBe(1); // only the ngit chip
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/webui.test.ts -t "clone chips"`
Expected: FAIL — `cloneCell` still renders a single link, no `clone-chip`/`data-copy`.

- [ ] **Step 3: Implement**

In `src/webui.ts`, replace the whole `cloneCell` function (lines 98-105) with:

```typescript
/** Short label for a mirror host: the registrable name (github.com → "github",
 *  codeberg.org → "codeberg"); falls back to the full hostname, then "git". */
function mirrorLabel(url: string): string {
  try {
    const host = new URL(url).hostname;
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch { return "git"; }
}

/** A click-to-copy clone chip. `command` is the full `git clone …` line; it is the
 *  copy payload (data-copy), the hover tooltip (title), and never an href. */
function cloneChip(label: string, command: string, extraClass = ""): string {
  const cls = extraClass ? `clone-chip ${extraClass}` : "clone-chip";
  return `<button class="${cls}" type="button" data-copy="${escapeHtml(command)}" aria-label="Copy ${escapeHtml(label)} clone command" title="${escapeHtml(command)}"><span class="cc-ic" aria-hidden="true">⧉</span>${escapeHtml(label)}</button>`;
}

function cloneCell(it: MultiRepoItem): string {
  const chips: string[] = [];
  const ngit = ngitCloneUrl(it.owner, it.d, it.relays);
  if (ngit) chips.push(cloneChip("ngit", `git clone ${ngit}`, "ng"));
  if (it.cloneUrl) {
    const c = safeClone(it.cloneUrl);
    if (c && c.kind === "href") chips.push(cloneChip(mirrorLabel(c.url), `git clone ${c.url}`));
  }
  return `<td class="clone" data-label="clone">${chips.join("")}</td>`;
}
```

In the `<style>` block, add these rules (next to the existing `.copy-id` / table styles — anywhere inside `<style>…</style>`):

```css
  .clone-chip { font: inherit; font-size: .8rem; display: inline-flex; align-items: center; gap: 3px; border: 0.5px solid #8884; border-radius: 6px; padding: 1px 7px; margin: 0 3px 0 0; cursor: pointer; background: transparent; color: inherit; }
  .clone-chip:hover { border-color: #8888; }
  .clone-chip .cc-ic { opacity: .6; }
  .clone-chip.ng { border-color: #1d9e7577; color: #1d9e75; }
```

In the inline `<script>`, add a generic copy listener immediately AFTER the existing `.copy-id` listener (the block ending `})); ` just before `document.querySelectorAll(".claim-btn")…`):

```javascript
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const cmd = b.dataset.copy;
    if (!cmd || !navigator.clipboard) return;
    const ic = b.querySelector(".cc-ic") || b;
    navigator.clipboard.writeText(cmd).then(() => {
      const t = ic.textContent; ic.textContent = "✓";
      setTimeout(() => { ic.textContent = t; }, 1000);
    }).catch(() => {});
  }));
```

(The `.copy-id` button has no `data-copy`, so it stays handled by its own listener — no double-binding.)

- [ ] **Step 4: Run the full webui suite + typecheck**

Run: `npx vitest run test/webui.test.ts && npm run typecheck`
Expected: PASS — clone chips render, the old single-clone test is gone, the existing claim-control / escaping / WNJ / unreachable tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/webui.ts test/webui.test.ts
git commit -m "feat(webui): clone cell → ngit + mirror copy chips"
```

---

## Final verification (after all tasks)

- [ ] **Full suite + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: ALL pass (159 baseline + the new tests; ≈ 159 + ~10 added − 1 removed), typecheck clean.

- [ ] **Live verification** — `npm run serve registry.json`, open `http://localhost:8787/`, and confirm:
  - **prana** rows show an `ngit` chip (copies `git clone nostr://npub1xy54…/relay.ngit.dev/prana`) and a `github` chip (copies `git clone https://github.com/DocNR/prana.git`).
  - **ngit** rows show an `ngit` chip and a `codeberg` chip.
  - Clicking a chip copies a working `git clone …` command (paste to check); the `⧉` flips to `✓` briefly.
  - No row has a `javascript:`/non-gitworkshop href introduced.

- [ ] **Security review** — run a security pass on the branch diff (`git diff main...HEAD`), focused on the new `cloneCell`/`ngitCloneUrl`/`data-copy` sinks (no `href`, all `escapeHtml`'d, clipboard plain-text only).

- [ ] **Finish** — use superpowers:finishing-a-development-branch. Merge `feat/clone-remotes` → `main`; pushing prompts the Clave signer and needs `~/.cargo/bin` on PATH — pause and ask before pushing.

---

## Self-Review

- **Spec coverage:** two intent-framed chips → Task 3; `ngit` URL builder (shared `repoCoordPath`, gitworkshop behavior-preserving) → Task 1; mirror selection skipping grasp/npub URLs → Task 2; copy-on-click via generic `[data-copy]` listener → Task 3; host-derived mirror label → Task 3 (`mirrorLabel`); ngit-only / mirror-only / empty / adversarial cases → Task 3 tests; security (no href, escaped, clipboard plain-text) → Task 3 + final review. All covered.
- **Type consistency:** `repoCoordPath(owner,d,relays)`, `ngitCloneUrl(owner,d,relays)`, `gitworkshopRepoUrl(owner,d,relays)` all share the same signature; `pickMirrorClone(cloneList)` and `mirrorLabel(url)`/`cloneChip(label,command,extraClass)` are each defined once and used consistently; `MultiRepoItem.cloneUrl` type is unchanged (`string | null`).
- **Placeholder scan:** none — every step has complete code.
- **Behavior-unchanged check:** `gitworkshopRepoUrl` output is byte-for-byte identical (verified-format test guards it); the signer/claim/publish flow, the copy-id listener, folds, fetch/resolve, and the unreachable banner are untouched; `cloneUrl` semantics narrow from "first https" to "first non-grasp http(s)" (same result for prana/ngit).
