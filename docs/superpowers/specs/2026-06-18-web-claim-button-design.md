# Web claim/release button + clone link — design spec

**Status:** proposed design, awaiting final user sign-off (then an implementation plan).
**Hardened by** a focused adversarial design review (2026-06-18) of the render/XSS and
sign-safety surfaces — see *Adversarial review dispositions* at the end.
**Scope:** close the contributor loop in the web UI — a state-aware **Claim / Release**
button per row, signed by the *visitor's* own signer, plus a per-repo **clone** link.
**Builds on:** the shipped claim primitive (`src/claim.ts` `buildClaimEvent`, the fold
`src/claimResolver.ts`, the gate `src/claimFetch.ts`) and the read-only web UI
(`src/server.ts` + `src/webui.ts`). Folds in backlog issue `d65fcb90` (clone-url deep-link).

## Problem & context

PRana can already surface correctly-open, claim-tagged issues across repos, and the
`npm run claim` CLI can mint/release a claim. But a visitor browsing the web worklist has
no way to *act* — they must drop to a terminal. This slice makes the loop real in the
page: **browse → claim → (go fix) → release**, and shows **how to get the code**.

The hard constraint: a claim is signed `by: <the claimant's pubkey>`. **PRana's server must
never sign it** — signing server-side would attribute every claim to PRana's key and break
the per-pubkey fold. So the write path lives entirely in the visitor's browser, driven by
*their* signer. The server stays a read-only directory.

## Decisions locked in brainstorming

1. **Signer = `window.nostr.js` (WNJ).** Drop-in CDN script that exposes a NIP-07
   `window.nostr` (`getPublicKey`, `signEvent`) and, when no extension is present, offers
   its own UI for **NIP-46 bunker / nostrconnect** (Clave) or a local key. One call site
   (`window.nostr.signEvent`) covers the extension *and* mobile-signer audiences; we do not
   hand-roll a NIP-46 flow.
2. **Server stays read-only.** No write endpoint, no PRana key. The browser **signs (WNJ)
   then publishes** the signed event. Publish via a small **raw-WebSocket** helper
   (`["EVENT", e]` → await `OK`) — no new runtime dependency beyond WNJ; WNJ only signs, it
   does not publish. **Publish targets = the registry-trusted relays**, not the raw
   announcement `relays` (a malicious announcement could name attacker-controlled hosts —
   see review #2/#3). Each URL is parsed with `new URL()`, accepted only if `protocol ===
   "wss:"`, de-duplicated, and **capped (≤ 8)** per row.
3. **No builder duplication.** The server pre-builds the unsigned claim **skeleton** with the
   real `buildClaimEvent` (it needs no pubkey — that's added at signing) and embeds it per
   row, **plus the `TTL` constant** (`DEFAULT_TTL_SECONDS`). The client only **stamps
   `created_at = now`, sets `expiration = now + TTL`, sets the `status` tag**
   (`claimed`/`released`), signs, and publishes. `buildClaimEvent` remains the single source
   of truth; a render test asserts the embedded skeleton's static tags match it.
   **Embedding rule (review #1/#7):** all JSON lives in a **`data-*` attribute** written
   `data-skeleton="${escapeHtml(JSON.stringify(skeleton))}"` (stringify **then** HTML-escape,
   double-quoted) and read client-side via `JSON.parse(el.dataset.skeleton)`. **Never** an
   inline `<script>` JSON blob — `escapeHtml` does not neutralize `</script>`.
4. **Claim *and* release.** The button is state-aware:
   - row available → **Claim**;
   - row held by the *connected visitor* → **Release**;
   - row held by someone else / contended → inert label (`claimed · <pubkey8>` / `contended`).
5. **Clone link folded in (`d65fcb90`).** Each row surfaces the repo's clone URL (from the
   `30617` announcement `clone` tag), so a just-claimed issue answers "now what?". An
   `http(s)` clone URL renders as a clickable, scheme-checked link; a `nostr://` clone URL
   (not browser-openable) renders as copyable `git clone nostr://…` text instead.
6. **Optimistic UI, gated on a trusted `OK` (review #3).** The row flips only after at least
   one **registry-trusted** relay returns `["OK", id, true, …]`; if every relay fails/rejects,
   show an explicit error and do **not** flip (a single attacker relay must not be able to
   fake success). The flip is advisory; the 60s server cache reconciles canonical state on the
   next render. No live re-fetch this slice.

## NIP-40 reminder (carried from the CLI)

A **release** must carry a **future** `expiration` (`now + TTL`), never `now`: NIP-40 relays
drop already-expired events (`event is expired`), so a `now`-valued release silently fails
to publish. The fold frees the issue on the `released` *status*, not on expiry. The client's
release path reuses the same `now + TTL` expiry as a claim. (See `buildClaimEvent`, which
already enforces this; the client mirrors it.)

## Data flow

```
server (read-only)                         browser (the write path)
─────────────────                          ────────────────────────
buildMultiRepoWorklist ── per item ──▶ row carries:
  + relays (publish targets)               data-issue-id, data-relays,
  + cloneUrl (from announcement)           data-skeleton (unsigned tags), data-clone
                                             │
                                  Claim/Release click
                                             │  stamp created_at/expiration, set status
                                             ▼
                                   window.nostr.signEvent  (WNJ → NIP-07 / NIP-46 Clave)
                                             │
                                             ▼
                                   publish raw-WS to data-relays ── await OK
                                             │
                                             ▼
                                   optimistic row flip
```

## What changes

| File | Change |
| --- | --- |
| `src/nip34.ts` | add `repoClone(announcement): string[]` (read `clone` tag values), mirroring `repoRelays`. |
| `src/registry.ts` | thread `relays: string[]` and `cloneUrl: string \| null` onto `RepoInput` (known in `fetchRepoInput`) → copy onto each `MultiRepoItem`. |
| `src/webui.ts` | render: WNJ `<script>` (+ `wnjParams`), per-row Claim/Release cell + clone affordance, and `data-*` (full issue id, relays, embedded skeleton, holder pubkey, clone url); add the inline client handler (connect / sign / publish / optimistic flip). |
| `src/server.ts` | none of substance — items now carry the extra fields; server stays read-only. |
| `test/webui.test.ts` | extend (see Testing). |

### Visitor identity (for showing Release)

The page does **not** auto-connect a signer on load (that would pop the signer UI
unprompted). A small **connect** control — or the first Claim click — calls
`window.nostr.getPublicKey()` once and caches the visitor pubkey for the session. Rows where
`holder === visitorPubkey` then expose **Release**. Until connected, held rows render their
read-only label and available rows show **Claim** (clicking Claim triggers the WNJ connect,
then signs).

**Encoding + target contract (review #4):** `visitorPubkey` and `holder` are compared as
**lowercase 64-hex** — normalize `getPublicKey()`'s output; the fold already emits hex. The
Release handler reads its `d`/`e` target from the **clicked row's own element** (its embedded
skeleton), never a shared "current issue" variable, so an optimistic re-render can't retarget
it. A release the visitor signs only ever affects **their own** claim (the fold is keyed by
signer pubkey) — so the published event carries no "holder" parameter and cross-user release
is impossible by construction.

## Security & trust model

- **Untrusted strings escaped, in the right context.** Subjects, repo names, relays, clone
  URLs, and the skeleton JSON all originate from untrusted nostr events. All are
  HTML-attribute/text-escaped via `escapeHtml`, and **JSON is embedded only in `data-*`
  attributes** (`escapeHtml(JSON.stringify(x))`) — never in an inline `<script>` (review #1).
  `escapeHtml` is an attribute/text escaper, not a `<script>`- or scheme-context escaper;
  the design must not rely on it outside those two contexts.
- **Clone URL — parse, don't pattern-match (review #5).** The clone URL is attacker-controlled.
  Validate with `new URL(clone)` and emit an `href` **only** when `url.protocol` is exactly
  `"http:"` or `"https:"`; render `nostr:` as inert escaped text; **drop** every other scheme
  (`javascript:`, `data:`, `vbscript:`, …). Note explicitly: HTML-escaping does **not** make a
  bad scheme safe in an `href`. The `nostr:` affordance is plain selectable text (no auto-copy
  of a shell-prefixed string).
- **Relay URLs — parse + cap (review #2/#3).** Publish only to **registry-trusted** relays;
  each parsed with `new URL()`, kept only if `protocol === "wss:"`, de-duplicated, capped ≤ 8.
  Do not open sockets to hosts named by an untrusted announcement. Document that a claim is a
  public event, but publishing still discloses the visitor's pubkey to the target relays.
- **WNJ supply chain + signer blast radius (review #6).** Load WNJ from a **version-pinned**
  CDN URL with an **SRI hash** + `crossorigin`. A compromised WNJ is a *signer oracle* — it can
  ask the visitor's signer to sign arbitrary events; with a **NIP-46 remote signer the key
  stays remote and each sign can be denied, but with a WNJ-managed local key the key is
  exfiltratable**. So: prefer/recommend an extension or NIP-46 signer over the local-key path
  in the UI copy; the page only ever constructs **kind-31621** templates (defense-in-depth);
  vendoring WNJ locally is the real fix (tracked, Out of scope).
- **Render invariant (review #8).** Every value reaching `renderWorklistHtml` is either a
  `verifyEvent`-guaranteed 64-hex id or opaque untrusted text. Belt-and-suspenders: if an
  `issueId` is not 64-hex, render the row **without** a Claim/Release control (you can't build
  a valid skeleton) — same posture as the no-relays rule.
- The server still signs nothing and exposes no write endpoint; the only new privilege is the
  browser opening `wss://` sockets to the **registry-trusted** relays.

## Testing

`webui.ts` stays a pure render → covered in `test/webui.test.ts` (no network):

1. **available row** → renders a Claim button; embeds a skeleton whose static tags
   (`kind` 31621, `d`, `e`-root, `status:claimed`) **equal `buildClaimEvent(id,{now:0})`**'s
   (parity — guards against builder drift); `data-relays` present.
2. **claimed row** → no Claim button; shows `claimed · <pubkey8>`; emits `data-holder` so the
   client can decide Release; **contended** row shows the contended label.
3. **clone link** → an `https` clone URL renders as an escaped `href`; a `nostr:` URL renders
   as escaped copyable text (no `href`); a `javascript:` clone URL is dropped (XSS guard).
4. **escaping** → a subject / repo / relay containing `"` `<` `'` cannot break out of the
   attribute or inject script.
5. **no-relays repo** → row renders without a Claim button (nothing to publish to) rather
   than emitting a broken control.
6. **`</script>` breakout (review #1)** → a subject containing `</script><img src=x onerror=…>`
   produces no `</script>` token and no executable markup; the skeleton attribute still
   `JSON.parse`s (round-trip assertion).
7. **clone scheme bypasses (review #5)** → `javascript:`, `data:`, `vbscript:`, mixed-case
   (`HtTpS:`), and leading-whitespace variants never emit a live `href`.
8. **non-hex id (review #8)** → an `issueId` that is not 64-hex renders the row with no
   Claim/Release control.
9. **relay parse + cap (review #2)** → publish-target derivation rejects non-`wss:` URLs,
   de-dupes, and caps the list (≤ 8); covered as a small pure helper alongside the render.

The client edge (WNJ connect, `signEvent`, raw-WS publish, optimistic flip) is **I/O at the
boundary** — verified **live in a browser** against both a NIP-07 extension and a NIP-46
signer (Clave), the same way the claim CLI was dogfooded. Not unit-tested.

## Out of scope / deferred

- **Live re-fetch / contention resolution in the page.** Optimistic flip only; the 60s
  cache reconciles. Real-time claim updates and "someone beat you to it" handling are later.
- **Refresh (extend TTL) button.** Claim and release only; a holder re-claims via the CLI to
  extend for now.
- **Vendoring WNJ** locally (CDN + SRI this slice).
- **Maintainer actions** (resolve/close) from the page — that's `ngit`'s job, not PRana's.
- **Persisting the visitor's signer session** beyond what WNJ itself does.
- **A server write/publish endpoint** — explicitly avoided; the browser publishes.

## Adversarial review dispositions (2026-06-18)

A focused red-team pass attacked this design's **render/XSS** and **sign-safety** surfaces
before implementation (fold semantics were out of scope — already hardened in the
2026-06-17 review). Verdict: architecture is sound (read-only server / browser-signs /
single `buildClaimEvent`); the gaps were *policy stated without mechanism*. Dispositions:

- **Fixed in this spec:**
  - **#1 (High)** `</script>` breakout — JSON embedded only in `data-*` attributes via
    `escapeHtml(JSON.stringify(...))`, inline-`<script>` JSON forbidden; test 6.
  - **#2 (High)** attacker-named publish relays — publish to **registry-trusted** relays
    only, `new URL()` + `wss:`-only + de-dupe + cap ≤ 8; test 9.
  - **#3 (Med)** faked publish success — optimistic flip gated on a trusted relay `OK
    (accepted=true)`; all-fail shows an error, no flip.
  - **#4 (Med)** Release gating — lowercase-64-hex compare contract; handler reads target
    from the clicked row's element; cross-user release impossible (fold is pubkey-keyed).
  - **#5 (Med)** clone scheme bypass — `new URL().protocol` allow-list (`http(s)` href only,
    `nostr:` inert text, drop the rest); `escapeHtml ≠ scheme-safe` noted; test 7.
  - **#6 (Med)** WNJ supply chain — SRI + `crossorigin`; document signer blast radius;
    recommend remote-signer over local key; page only builds kind-31621.
  - **#7 (Low)** attribute JSON escape ordering — pinned to `escapeHtml(JSON.stringify(...))`
    + `JSON.parse(dataset)`.
  - **#8 (Low)** non-hex id render invariant — stated; defensive `HEX64` guard drops the
    claim control; test 8.
- **Deferred (tracked):** vendoring WNJ locally (the durable supply-chain fix; CDN+SRI now).
- **Accepted:** a claim is a public event, so disclosing it (and the visitor's pubkey) to the
  registry-trusted relays it's published to is inherent to the model.
