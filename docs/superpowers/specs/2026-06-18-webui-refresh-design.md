# Web worklist UI refresh — design

**Date:** 2026-06-18
**Status:** approved-pending-spec-review
**Builds on:** `feat/unreachable-repo-row` (this branch `feat/webui-refresh` is stacked on it; the web worklist already renders the unreachable-repo banner).

## Goal

Make the server-rendered web worklist (`src/webui.ts`, served by `src/server.ts`) more usable: kill the wasted horizontal space, add column sorting, link rows back to gitworkshop.dev, and add a few small affordances — without touching fetch/resolve/fold/build behavior.

## Context (current state)

`renderWorklistHtml(items, unreachable)` emits one self-contained HTML page: a summary line, an unreachable banner, a filter bar (size pills + repo `<select>` + available-only checkbox), and a single `<table>` of issues, plus one vanilla `<script>` that does client-side filtering and the claim/release publish flow. There is no framework and no build step for the page — just template strings. The page is `max-width: 960px`, which leaves large empty space to the right on a normal desktop. Issue subjects currently deep-link to njump.me.

Each row already carries data attributes: `data-cx` (S/M/L), `data-repo`, `data-avail` (true/false), `data-issue-id` (full hex), `data-relays`, `data-holder`, `data-skeleton`.

## Confirmed gitworkshop.dev URL formats

Verified against live pages the maintainer pasted, and decoded with the project's own `nostr-tools`:

- **Repo:** `https://gitworkshop.dev/<npub>/<relay-host>/<d>`
  e.g. `https://gitworkshop.dev/npub1xy54…/relay.ngit.dev/prana`
- **Issue:** `<repo-url>/issues/<nevent>`
  e.g. `…/relay.ngit.dev/prana/issues/nevent1qy28…`

Where:
- `<npub>` = `nip19.npubEncode(owner)` (owner = the 30617 announcement author pubkey; for prana decodes to `3129509e…c846f506`, matching `registry.json` ✓).
- `<relay-host>` = the host of the repo's **first announced relay** (`new URL(relays[0]).host` → `relay.ngit.dev`).
- `<d>` = the repo identifier, `encodeURIComponent`-d for the path segment.
- `<nevent>` = `nip19.neventEncode({ id: issueId, relays: [relays[0]] })`. Confirmed: encoding `{ id: ac257db6…03ffcf, relays: ["wss://relay.ngit.dev"] }` round-trips **byte-for-byte** to the nevent gitworkshop served (single relay hint, no author).

The same first-announced relay supplies both the `<relay-host>` path segment and the `nevent`'s single relay hint.

## Scope

**In:**
1. Wide fluid layout (deadspace fix).
2. Sortable column headers.
3. Sticky table header + live "showing N of M" filter count.
4. Copy-issue-id button.
5. Responsive narrow-screen layout (< 640px).
6. gitworkshop.dev repo + issue links (replacing the njump issue link).

**Out / deferred:**
- Complexity-reason tooltip on the S/M/L badge (sizing will migrate to ngit labels later — not worth surfacing the heuristic now).
- The card-grid (C) and left-filter-rail (B) layouts.
- Any change to fetch/resolve/claim-fold/`buildClaimEvent`/`buildMultiRepoWorklist` sort order or the claim/release publish flow.
- Age/`created_at` column (would need new data plumbing through resolve→worklist; not in scope).

## Detailed design

### 1. Layout & sorting

- Raise the page `max-width` from `960px` to `1200px` (centered). The table is already `width: 100%`, so the `subject` column absorbs the freed width. 1200px is a deliberate cap so subject lines stay readable on ultrawide monitors; it is a single tunable constant.
- Make the `repo`, `size`, `claim`, and `subject` `<th>` sortable. Each sortable header is a `<button>`-like clickable cell with `aria-sort` reflecting state and a visible ascending/descending arrow indicator. The `id`, action, and clone columns are not sortable.
- Comparators (client-side, over the existing row set):
  - `repo`, `subject`: case-insensitive string compare.
  - `size`: by complexity order S < M < L (read `data-cx`), **not** alphabetic.
  - `claim`: available before taken (read `data-avail`), tie-break by holder text.
- Click toggles ascending ⇄ descending for that column; switching columns starts ascending. The **initial** order is unchanged — the existing global server-side sort (available → S→L → repo → id). Reload returns to that initial order (no separate "reset" control — YAGNI).

### 2. Sticky header + live count

- `thead th { position: sticky; top: 0; background: Canvas; }` (the `Canvas` system color respects the existing `color-scheme: light dark`), so headers stay visible while scrolling a long list.
- The summary line gains a live "showing N of M" that recomputes whenever a filter (size pill / repo select / available-only) changes. M is the total rendered row count; N is the count currently visible. Implemented in the existing `apply()` function.

### 3. Copy issue id

- A small icon button in the `id` cell copies the **full hex** issue id (`tr.dataset.issueId`, already present) to the clipboard via `navigator.clipboard.writeText`, with brief visual "copied" feedback that reverts after ~1s. Full hex is what `ngit issue resolved/close <id>` and the claim flow accept. No new data attribute needed.
- `aria-label` on the icon-only button for accessibility.

### 4. Responsive (< 640px)

- A `@media (max-width: 640px)` block collapses the table to stacked blocks: `thead` hidden; each `tr` becomes a bordered card; each `td` becomes a flex row showing a label (via `data-label` attributes added to cells) and its value. The filter bar wraps (already does). Goal: usable on a phone without horizontal scroll.

### 5. gitworkshop.dev links

- All gitworkshop URL knowledge lives in `webui.ts` (one place). Two pure helpers:
  - `gitworkshopRepoUrl(owner, d, relays): string | null` → `https://gitworkshop.dev/${npub}/${host}/${encodeURIComponent(d)}`, or `null` if `relays` is empty or `owner` can't be npub-encoded.
  - `gitworkshopIssueUrl(repoUrl, issueId, relays): string | null` → `${repoUrl}/issues/${neventEncode({ id: issueId, relays: relays.slice(0,1) })}`, or `null` if `repoUrl` is null or the id can't be encoded (e.g. synthetic non-hex test ids).
- Repo name cell → repo URL (when non-null). Issue subject → issue URL (when non-null); otherwise the subject renders as plain escaped text (today's null-link behavior — no broken `href`). The njump-based `issueLink` is removed/replaced.
- `target="_blank" rel="noopener"` as the existing links use.

### Data plumbing

- `src/registry.ts`: extend `MultiRepoItem` with `owner: string` and `d: string`. In `buildMultiRepoWorklist`, set them from `r.ref.owner` / `r.ref.d` in the existing push (`all.push({ ...it, repo: label, owner: r.ref.owner, d: r.ref.d, relays, cloneUrl, claimSkeleton })`). No other registry change; sort order, claim skeleton, and unreachable handling are untouched.

## Files touched

- `src/registry.ts` — add `owner`/`d` to `MultiRepoItem` (+ populate). Small.
- `src/webui.ts` — the bulk: link helpers, sortable header markup + sort/`aria-sort` script, copy-id button + handler, sticky/responsive CSS, `data-label` attributes, live count. Stays server-rendered string HTML + one vanilla `<script>`. Every interpolated value remains `escapeHtml`-escaped.
- `test/registry.test.ts` — assert items carry `owner`/`d`.
- `test/webui.test.ts` — assert rendered HTML (see Testing).

## Testing

Mirror the existing `webui.test.ts` style (string assertions on rendered HTML; the interactive `<script>` is not unit-tested — it is verified live in a browser, as the current claim flow is):

- gitworkshop repo `href` is built with the right `npub` / relay-host / `d` for an item with a valid owner + relays.
- issue subject `href` ends with `/issues/nevent1…`.
- when `relays` is empty → no repo/issue link (plain text), no broken `href`.
- when the issue id is non-hex/synthetic → subject is plain text.
- sortable `<th>` carry the sort markup (`aria-sort` / data hook); non-sortable columns do not.
- sticky CSS (`position: sticky`) and the `@media (max-width: 640px)` block are present.
- copy-id button present with an `aria-label`.
- `escapeHtml` still applied to subject/repo (XSS regression guard).
- `buildMultiRepoWorklist` items expose `owner` and `d`.

**Live verification:** `npm run serve registry.json`, then in the browser confirm: no right-side deadspace at desktop width; clicking headers re-sorts (size in S→M→L order); repo/issue links open the correct gitworkshop pages; copy-id puts the full hex on the clipboard; "showing N of M" updates with filters; the page is usable narrowed to phone width.

## Security

`webui.ts` renders UNTRUSTED nostr strings (subjects, repo names). All interpolation stays `escapeHtml`-escaped. URLs are built only from npub/nevent encodings of validated ids and from `new URL(...).host` of the repo's own relays — no untrusted string is placed into an `href` unescaped. `safeClone` (clone column) is unchanged.

## Open questions

None — layout direction (A), link behavior (repo + issue → gitworkshop, njump dropped), the extras set (sticky+count, copy-id, responsive; tooltip deferred), and both URL formats are all confirmed.

## Branch / merge logistics

`feat/webui-refresh` is stacked on `feat/unreachable-repo-row` (unmerged, local-only). At merge time, either (a) merge `feat/webui-refresh` → `main` as one unit (brings in both the unreachable-repo work and this refresh), or (b) merge `feat/unreachable-repo-row` → `main` first for a separate unit, then this. Decide at finish time. Pushing `main` prompts the Clave signer and needs `~/.cargo/bin` on PATH — pause and ask the maintainer before any push.
