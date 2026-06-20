# PRana event kinds

A single reference for the Nostr event kinds PRana reads, the one custom kind it writes, the conventions it proposes, and the kinds a future ContextVM front door would use. Source of truth in code: the `KIND` enum in `src/types.ts`.

**Trust boundary (applies to everything below):** every event coming off a relay passes `nostr-tools` `verifyEvent` at the fetch/ingest gate (`src/fetch.ts`) and is dropped on failure before it reaches the resolvers. The resolvers and folds are pure and trust `event.pubkey`. So "who may assert what" is enforced by signature plus an authority check, never by the relay.

## NIP-34 kinds consumed (read only)

| Kind | Name | How PRana uses it |
|---|---|---|
| `30617` | repo announcement (addressable) | Discovered by `authors` + `#d`. Carries `relays`, `clone`, `maintainers`, and `r ... euc` (earliest-unique-commit) used to group forks. Defines the maintainer authority set (owner + `maintainers`). |
| `1621` | issue | Belongs to a repo via its `a` tag. PRana prefers the `root`-marked `a` and excludes pure `mention`s (finding #1). Free-form `t` labels exist but are too sparse/inconsistent to derive complexity from (finding #3), so complexity is inferred from issue text. |
| `1630` / `1631` / `1632` / `1633` | status: open / resolved / closed / draft | Each `e`-tags the issue it governs. An issue has no embedded status: its state is the most recent (by `created_at`) status event signed by the **issue author or a recognized maintainer**. No valid status event means Open. Ties broken by event id; ambiguity is surfaced, not hidden. (`1631` is "Resolved" for issues, "Applied/Merged" for patches.) |

**Not handled yet:** `1617` patch, `1618` PR, `1619` PR-update. PRana reads issues and their status today, not the patch/PR proposal flow.

## PRana custom kind

| Kind | Name | Status |
|---|---|---|
| `31621` | claim (addressable) | **Implemented** (read fold, ingest gate, write CLI, web UI). Kind number is **PROVISIONAL and unreserved**: reserve it before any cross-client use. |

A claim is a soft "I'm on this" signal so two contributors do not burn quota on the same issue. It is advisory, not a lock (Nostr has no mutex); PRana surfaces claims and picks a canonical holder.

As-built event (see `buildClaimEvent` in `src/claimEvent.ts`):

```
kind: 31621
pubkey: <contributor>             // self-asserted; only the signature is verified
created_at: <unix>
tags:
  ["d", "<issue-id>"]             // addressable key: latest claim per (pubkey, issue)
  ["e", "<issue-id>", "", "root"] // which issue (mirrors status events)
  ["expiration", "<unix>"]        // NIP-40, always FUTURE (now + ttl); see TTL below
  ["status", "claimed"]           // claimed | released
content: ""
```

- **Addressable**, so re-claiming, refreshing the TTL, and releasing are just newer events at the same `(pubkey, d)` coordinate. NIP-01 replaceability gives "one active claim per (pubkey, issue)" for free.
- **TTL:** default 3 days, hard max 14 days (`DEFAULT_TTL_SECONDS` / `MAX_TTL_SECONDS`). A release also carries a future `expiration`, because NIP-40 relays reject already-expired events.
- **Ingest gate (`isAdmissibleClaim`):** drops a claim whose `expiration` is beyond `now + 14d` or whose `created_at` is future-dated. This blocks the "parking" attack (a far-future self-claim that squats an issue). Relay-side NIP-40 GC is treated as an optimization; the fold is the authority.
- **Fold (`resolveClaim`):** per issue, keep the latest claim per pubkey; a claim is ACTIVE iff `status == "claimed"` and `now < expiration`; zero active = unclaimed, one = claimed, two or more = contended (canonical holder is the earliest active claim, first-come, and the contention is surfaced).
- **Non-custodial:** the claim is a plain Nostr event on relays, attributable to the contributor's key, and survives even if PRana disappears. See `docs/claim-primitive.md` for the full rationale.

## Proposed conventions (designed, not built; for review)

These are the trust-model decisions for routing agents. They need ecosystem input (DanConwayDev / gzuuus). See `docs/superpowers/specs/2026-06-18-agent-eligibility-design.md`.

- **Repo consent (gates the global directory):** a tag on the repo's `30617` announcement (provisional, e.g. `["t", "agent-contributions"]`) means the maintainer opts the repo in to being listed as an agent-contribution target. Reading issues and opening PRs stay permissionless; only PRana's listing/promotion is gated. The exact tag name needs upstream blessing.
- **Issue eligibility (strict maintainer whitelist):** an issue is an agent target only if a **recognized maintainer** has labeled it `agent-ok`. Because you cannot edit another author's event, the label is a separate maintainer-signed event that references the `1621` issue by id (the same shape as a status event), which is exactly why a maintainer can whitelist an issue a non-maintainer opened. PRana resolves it with the same fold as status: gather label events referencing the issue, keep only maintainer-signed ones, look for `agent-ok`. Non-maintainer self-labels are ignored, which also makes this the issue-level spam defense. Open detail: confirm the exact kind/tag `ngit issue label` emits so PRana reads it.

## Future: ContextVM front door (MCP over Nostr)

Not built here; this is the agent-facing layer that would sit on top, likely implemented with gzuuus. See `docs/contextvm-fit.md`.

| Kind | Use |
|---|---|
| `25910` (ephemeral) | MCP JSON-RPC request/response transport. A request `p`-tags the server, a response `e`-tags the request and `p`-tags the client. |
| `11316`–`11320` | capability announcements (server, tools, resources, resource templates, prompts). |

Mapping: expose the worklist as an MCP server over Nostr with tools `list_open_issues` / `claim` / `release` / `report_status`. The agent signs each call (and the claim it publishes) with its own Nostr key, so a CVM claim is the **same `31621` event** as a hand-made one. One source of truth, two front doors; the claim event is never a CVM-custodial object.

## Authority summary

| Assertion | Who may make it | How PRana enforces it |
|---|---|---|
| Repo announcement / maintainers / consent tag | repo owner (the `30617` author) | it is the maintainer's own signed `30617` |
| Issue status (open/resolved/closed/draft) | issue author or recognized maintainer | signature + authority check in the status resolver |
| Issue eligibility (`agent-ok`) | recognized maintainer only | signature + maintainer-authority check (proposed) |
| Claim / release | anyone (self-asserted) | signature only, plus the admissibility gate against parking |
