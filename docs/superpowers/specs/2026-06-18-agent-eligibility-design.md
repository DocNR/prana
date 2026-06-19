# Agent-eligibility & worklist scoping — design (decision record)

**Date:** 2026-06-18
**Status:** model approved — shared decision record for three sub-projects (each gets its own spec → plan → implementation).
**Why this doc exists:** to make PRana's trust/scoping model legible — both for building, and for **gzuuus's review** ahead of a possible ContextVM (MCP-over-Nostr) front door. See `docs/contextvm-fit.md`.

## Problem

`registry.json` is **operator-curated**, not repo-opt-in — listed repos (e.g. ngit) never consented. And the worklist renders the whole registry globally. Two gaps as the eligible set grows: (1) no consent model (PRana could promote non-consenting repos / flood maintainers with unwanted AI PRs at scale), and (2) a single global firehose with no personalization. Tracked as ngit issues `8ba97209` (fetch scaling), `6e6aae22` (followed-repos), `e6706fe9` (consent).

## Established trust model (3 layers)

1. **Repo consent — gates the global directory.** Reading issues and opening PRs stay **permissionless** (public repos always allowed that). What requires consent is PRana **listing/promoting** a repo as an agent-contribution target. The signal: a tag on the repo's `30617` announcement (maintainer-owned, already fetched in `discoverAnnouncement`, updatable via `ngit repo edit`). Provisional convention; **propose upstream to DanConwayDev/gzuuus** as a NIP-34 addition.
2. **Issue eligibility (STRICT maintainer whitelist).** Within an opted-in repo, an issue is an agent target ONLY if a recognized maintainer (repo owner plus the announcement's `maintainers`) has labeled it `agent-ok`, no matter who opened the issue. Mechanism: you cannot edit someone else's nostr event, so the label is a separate maintainer-signed event that references the issue by id (the same shape as the 1630 to 1633 status events), which is exactly why a maintainer can whitelist an issue a non-maintainer submitted (`ngit issue label <id>` is gated "author or maintainer"). PRana resolves eligibility with the SAME fold the status resolver already runs: gather label events that reference the issue, keep only the maintainer-signed ones, look for `agent-ok`. Author / non-maintainer self-labels are ignored for eligibility. This doubles as the spam defense: a stranger cannot turn their own issue into an agent target by opening or self-labeling it; only a maintainer's pick counts.
3. **Two worklist views.**
   - **Global / default:** opted-in repos only — consent gates discovery-by-strangers.
   - **Personal (signed-in via `window.nostr`):** the viewer's NIP-51 followed repos, shown **regardless of opt-in** — they self-selected, and reading is permissionless. Claiming stays permissionless contributor-coordination (`isAdmissibleClaim` is unchanged — it only blocks the far-future "parking" attack, not who may claim).

Rationale: consent protects *stranger-promotion at scale*, not a contributor's own choices. A claim is contributor coordination (deconflicting duplicate work), not a contract imposed on the maintainer.

## Architectural implication (matters for sub-project b)

Today `src/server.ts` `buildHtml()` fetches the whole registry once and serves **one cached HTML for all visitors** (60s TTL); the browser only signs/publishes claims. The **personal view breaks this** — per-viewer content needs either:
- **client-driven** fetching (the browser reads the viewer's NIP-51 list and queries relays itself; it already has `window.nostr` + the publish path), or
- a **per-request / per-pubkey** server endpoint (reuses the existing TS fetch/resolve/worklist logic; cache keyed by pubkey).

Decision deferred to the (b) sub-spec; flagged here because it's a real shift, not a tweak.

## Decomposition (three sub-projects, sequenced)

- **(c) Consent / eligibility** — read the `30617` opt-in tag and gate the global directory to opted-in repos; then STRICTLY gate eligible issues to those a recognized maintainer has labeled `agent-ok` (resolved via the status-fold, ignoring non-maintainer labels). *Smallest, foundational, most review-relevant.* **Build first.** Use a provisional tag and flag the convention as pending upstream blessing, so building doesn't block on gzuuus and is cheap to adjust.
- **(b) Personal followed-repos view** — auth the viewer (reuse `window.nostr`), read their NIP-51 repo-follow list, build a worklist scoped to those coords, add a global/personal toggle. *Larger — the client-driven / per-viewer architecture change above.*
- **(a) Fetch scaling** — bounded concurrency across per-repo discover/issues/statuses/claim queries + caching/incremental refresh, without regressing the resilience guarantees (one warm pool, `discoverAnnouncement` retry, no dropped repos). *Pure perf; do when either view grows.*

Each is independently shippable and gets its own `spec → plan` cycle; this doc is the shared decision record.

## Open questions (need external input / live verification — not blockers to the design)

- **The `30617` consent tag shape/name** — provisional (e.g. `["t","agent-contributions"]` vs a dedicated key). Needs DanConwayDev/gzuuus input to standardize; PRana can read a provisional tag meanwhile.
- **What NIP-51 list means "following a repo"** — gitworkshop has a repo follow/bookmark concept; verify the exact kind/list (e.g. a `30000`/`30003`-style list of `30617` `a`-coords, or a gitworkshop-specific kind) with `nak` before building (b), the way `discoverAnnouncement`'s relay filter was verified live.
- **What `ngit issue label` actually emits** — the eligibility rule is decided (STRICT maintainer `agent-ok` whitelist, see layer 2). The one mechanical unknown: confirm with `nak` the exact event kind + tag `ngit issue label` publishes (a separate maintainer-signed event referencing the issue), so PRana reads the maintainer's label correctly.

## Out of scope

- The ContextVM front door itself (gzuuus's lane; this model *informs* the future `list_open_issues` scope but doesn't build the transport).
- Richer consent policy (rate limits, accepted complexity tiers, contribution guidelines) — start with a boolean opt-in.
- Spam/sybil resistance on self-registration beyond the consent signal.
