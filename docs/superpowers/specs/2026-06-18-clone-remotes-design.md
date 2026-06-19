# Clone remotes (ngit + mirror) — design

**Date:** 2026-06-18
**Status:** approved-pending-spec-review
**Branch:** `feat/clone-remotes` (off `main`, which now has the webui refresh).

## Goal

Replace the worklist's single clone link with up to **two intent-framed copy chips** in the clone cell — an **ngit (`nostr://…`)** clone for contributing back through PRana's nostr flow, and a **conventional mirror** (github/codeberg/…) for grabbing the code — so a contributor who lands on an issue can pick their contribution path, not just a download location.

## Context (current state)

The `30617` announcement's `clone` tag lists multiple git-server URLs. Real data:
- **prana:** `https://github.com/DocNR/prana.git`, `https://relay.ngit.dev/npub1xy54…/prana.git`
- **ngit:** `https://codeberg.org/DanConwayDev/ngit-cli.git` + three grasp servers (`relay.ngit.dev`, `gitnostr.com`, `ngit.danconwaydev.com`), all embedding the owner npub.

Today `src/registry.ts` `fetchRepoInput` does `cloneList.find(u => u.startsWith("https://"))` → keeps **only the first** URL and **hides the nostr-native server entirely**. `src/webui.ts` `cloneCell` renders that one URL as a "clone" link (https) or inert `git clone nostr://…` text (nostr).

Each worklist row already carries `owner`, `d`, and `relays` (added in the webui refresh), which is exactly what's needed to construct the nostr clone URL — the same inputs behind `gitworkshopRepoUrl`.

The two clone targets serve different contribution intents:
- **Mirror (github/codeberg):** familiar, plain `git clone`, no special tooling. But it's a *mirror* ngit pushes to; a PR opened there may not reach a maintainer who collaborates over nostr.
- **ngit / nostr clone** (`git clone nostr://npub…/relay.ngit.dev/<d>`): sets up the nostr remote so `ngit pr` lands the fix on nostr — where PRana's worklist, claim, and issue-status live. Requires ngit installed. This is the path the capacity-routing thesis depends on.

## Design

### Clone cell → two copy chips

The clone `<td>` renders up to two small chips (reusing the existing copy-to-clipboard handler — click copies, brief ✓ feedback; `title` shows the full command on hover; `aria-label` per chip):

- **`⧉ ngit` chip** (teal accent) — copies the full command `git clone nostr://<npub>/<relay-host>/<d>`. Built from the row's `owner`/`d`/`relays`. Shown only when buildable (valid 64-hex owner + a `wss:` relay).
- **`⧉ <host>` chip** (neutral) — copies `git clone <mirror-url>`. The label is the mirror host's second-level name (`github.com` → "github", `codeberg.org` → "codeberg"). Shown only when a mirror exists and is http/https.

If only one is buildable, render one; if neither, the cell is empty (today's behavior). The chips are `<button>`s, not links — there is no `href`.

### Mirror selection (registry.ts)

A grasp/nostr-native clone URL embeds the owner npub in its path (`…/npub1…/repo.git`); conventional mirrors do not. So the **mirror** is the first `clone` URL that is `https://` (or `http://`) **and does not contain `/npub1`**. Change the selection in `fetchRepoInput`:

```ts
// before:
const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;
// after — the conventional mirror (skip grasp servers, which embed the owner npub):
const cloneUrl = cloneList.find((u) => /^https?:\/\//.test(u) && !u.includes("/npub1")) ?? null;
```

`cloneUrl` now means *the conventional mirror* (for prana/ngit this still resolves to github/codeberg, just robustly). `MultiRepoItem.cloneUrl` is unchanged in type (`string | null`).

### ngit clone URL builder (webui.ts)

`gitworkshopRepoUrl` and the new ngit clone URL share identical path construction (`<npub>/<relay-host>/<encodeURIComponent(d)>` under the same guards), differing only in scheme/prefix. Extract a private helper and have both use it:

```ts
/** The shared `<npub>/<relay-host>/<d>` coordinate path, or null if unbuildable.
 *  owner must be 64-hex; relays[0] must be a wss: URL. Host is hostname-encoded
 *  (+ literal port); d is percent-encoded. */
function repoCoordPath(owner: string, d: string, relays: string[]): string | null {
  if (!/^[0-9a-f]{64}$/i.test(owner)) return null;
  if (!relays.length) return null;
  let host: string;
  try {
    const u = new URL(relays[0]);
    if (u.protocol !== "wss:") return null;
    host = encodeURIComponent(u.hostname) + (u.port ? `:${u.port}` : "");
  } catch { return null; }
  let npub: string;
  try { npub = nip19.npubEncode(owner); } catch { return null; }
  return `${npub}/${host}/${encodeURIComponent(d)}`;
}

export function gitworkshopRepoUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p && `${GITWORKSHOP}/${p}`;
}

/** ngit-native clone URL: `git clone <this>` sets up the nostr remote (needs ngit).
 *  Same coordinate as the gitworkshop link / the maintainer's own push remote. */
export function ngitCloneUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p && `nostr://${p}`;
}
```

This is behavior-preserving for `gitworkshopRepoUrl` — the exact-verified-format test must still pass byte-for-byte (`repoCoordPath` produces the same `<npub>/<host>/<d>` string).

### cloneCell (webui.ts)

`cloneCell(it)` builds:
- `ngit = ngitCloneUrl(it.owner, it.d, it.relays)` → if non-null, an `⧉ ngit` chip whose copy payload is `git clone ${ngit}` and whose `title`/`aria-label` reflect it.
- `mirror = it.cloneUrl` passed through `safeClone` → if `kind === "href"` (http/https), an `⧉ <host>` chip whose copy payload is `git clone ${mirror.url}`, label derived from the host. (`nostr:`/other → no mirror chip; the ngit chip already covers nostr.)
- Each chip carries the copy command in a `data-copy` attribute (`escapeHtml`'d); a single delegated handler copies `data-copy` to the clipboard. (The existing copy-id handler can be generalized to any `[data-copy]` element, or a sibling handler added — implementation detail for the plan.)

### Security

- `ngitCloneUrl` is built only from a validated npub + `wss:` host + percent-encoded `d` — no raw untrusted bytes; it can only ever be a `nostr://…` string.
- The mirror is gated to http/https via `safeClone` (drops `javascript:`/`data:`/etc.).
- Both commands are rendered only as `escapeHtml`'d attribute text (`title`, `data-copy`, `aria-label`) and written to the clipboard as plain text — no `href`, no scheme injection, no HTML sink. Same posture as the gitworkshop builders, which the security review cleared.

## Files touched

- `src/registry.ts` — mirror-selection one-liner in `fetchRepoInput`.
- `src/webui.ts` — extract `repoCoordPath`, refactor `gitworkshopRepoUrl`, add `ngitCloneUrl`, rewrite `cloneCell` to render the two chips, generalize/extend the copy handler to `[data-copy]`.
- `test/webui.test.ts` — `ngitCloneUrl` unit + adversarial tests; `cloneCell` rendering tests.
- `test/registry.test.ts` — mirror-selection test (skips npub/grasp URLs).

## Testing

- **`ngitCloneUrl`:** exact verified value for prana (`nostr://npub1xy54…/relay.ngit.dev/prana`); adversarial nulls (non-hex owner, empty relays, non-wss relay, non-URL relay); confirm `gitworkshopRepoUrl`'s exact-verified-format test still passes after the `repoCoordPath` refactor.
- **Mirror selection (registry):** a clone list `["https://github.com/o/r.git", "https://relay.ngit.dev/npub1…/r.git"]` → `cloneUrl` is the github URL; a list with only grasp (`/npub1`) URLs → `cloneUrl` is `null`.
- **`cloneCell` rendering:** an item with valid owner+relays+mirror → both an `ngit` chip (copy `git clone nostr://…`) and a host-labelled mirror chip (copy `git clone https://…`); no relays → ngit chip absent, mirror chip present; no mirror (`cloneUrl` null) → only the ngit chip; neither → empty cell; a hostile `cloneUrl`/`d`/`owner` stays escaped and never yields a non-`nostr://`/non-http href or attribute break-out (adversarial).
- **Live check:** `npm run serve registry.json` → confirm prana shows `ngit` + `github` chips and ngit shows `ngit` + `codeberg`; copying a chip yields a working `git clone …` command.

## Out of scope

- The `clone ▾` popover layout (chose chips).
- Changing the gitworkshop repo link or showing the announcement's `web` tag.
- Per-repo dedup/grouping of clone info (chips repeat per row, like today's clone cell).
- Surfacing more than one mirror, or the redundant extra grasp URLs.

## Branch / merge logistics

`feat/clone-remotes` branches off `main`. At finish, merge → `main`; pushing prompts the Clave signer and needs `~/.cargo/bin` on PATH — pause and ask before pushing.
