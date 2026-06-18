# ContextVM (CVM) — fit assessment

Decision note. Status: **adopt-ready — build on it, sequence behind the claim fold**
(updated 2026-06-17).

> Earlier this note said "watch, don't adopt yet," gating on whether the CVM NIP
> (#2246) was merged. That's the wrong gate for Nostr: NIPs typically merge only
> *after* they're working in the wild, so an unmerged #2246 is expected, not a red
> flag. ContextVM ships a published SDK (`@contextvm/sdk`) and is in use, so treat
> kind `25910` as a stable-enough target and build on it. What still holds is the
> *sequencing* — PRana needs the claim fold + worklist substrate before CVM has
> anything to sit on. The recommendation below is updated accordingly.

## What it is

ContextVM ("Context Vending Machine", CVM) is a convention for transporting
**MCP (Model Context Protocol) JSON-RPC over Nostr**. Relevant mechanics:

- **Kind `25910`** (ephemeral) carries all request/response traffic. A request
  `p`-tags the server pubkey; a response `e`-tags the request event id and
  `p`-tags the client. The JSON-RPC payload lives in `content`.
- **Identity is the Nostr pubkey** and every message is signed (verifiable).
  Optional end-to-end encryption via NIP-44 payloads wrapped in NIP-59 gift
  wraps. Servers control which client pubkeys are authorized.
- **Capability announcements** use kinds `11316`–`11320` (server, tools,
  resources, resource templates, prompts). Detailed *discovery* is deferred to
  future "CEPs" and is not yet specified.
- **SDK**: `@contextvm/sdk` (TypeScript) exposes `NostrServerTransport`,
  `NostrClientTransport`, `Gateway` (wraps an existing MCP server and exposes it
  over Nostr), `Proxy` (surfaces a remote Nostr MCP server as a local one),
  `RelayPool`, and `NostrSigner`. Reuses the same `nostr-tools`-style signer /
  relay primitives PRana's planned fetch layer needs anyway.

Maturity: OpenSats-funded, Show HN early 2026. The **NIP is still an open PR
([nostr-protocol/nips#2246](https://github.com/nostr-protocol/nips/pull/2246)),
not merged**, and kind `25910` is described as in-flux.

## Why it's a real fit for PRana (not a forced one)

PRana's thesis is *capacity routing*: send a contributor's AI agent — already an
MCP client — to a vetted backlog item. CVM is the missing interface for exactly
that:

- The worklist could be exposed as an **MCP server over Nostr**. A contributor's
  agent would then *discover the backlog, claim an issue, and report status as
  MCP tool calls* — no central API, no separate auth.
- The **identity model lines up**: CVM authenticates by Nostr pubkey, the same
  key that signs NIP-34 git events. A claim becomes attributable to the same
  identity that will later sign the patch — a clean reuse of the trust model the
  status resolver already centers on.
- It directly serves roadmap **#2 (claim primitive)** and **#5 (agent access /
  UI)**: a claim can be a CVM tool call rather than a bespoke custom kind.

## What gates adoption (it's sequencing, not the NIP)

Merge status is *not* a blocker — see the note at the top. What actually gates CVM
is that it's a transport/interface and needs something to carry:

1. **The substrate has to exist first.** CVM sits on top of: correctly-open issues
   (done — resolver + fetch gate), a claim primitive (the claim fold, in progress),
   and the worklist that ties them together (done). CVM exposes these; it doesn't
   replace building them.
2. **It introduces an identity-*producing* (signing) surface.** Today PRana only
   *reads* and verifies; CVM means the contributor's agent signs claim/status calls
   with its own key. That's a real addition, best done once the claim event shape is
   settled — which is exactly what the claim fold pins down.

Neither is a reason to avoid 25910; both are reasons to land the claim fold first.

## Recommendation

Build on CVM — just sequence it:

- **Now / in progress:** fetch+verify layer (done), complexity (done), worklist
  (done), claim fold (`resolveClaim`, in progress). These are the substrate.
- **Next, once the claim fold lands:** wire claim state into the worklist, then add a
  CVM front door — expose the worklist as an MCP server over Nostr (`list_open_issues`
  / `claim` / `release` / `report_status`), with the agent signing each call with its
  own Nostr key. Keep the claim *event* the source of truth (non-custodial); CVM is
  the agent-facing layer on top, not the store.
- The `@contextvm/sdk` reuses the same `nostr-tools` / signer / relay-pool primitives
  the fetch layer already uses, so adoption is incremental, not a rewrite.

## Sources

- ContextVM docs — Quick Overview: https://docs.contextvm.org/getting-started/quick-overview/
- ContextVM TS SDK (`@contextvm/sdk`): https://github.com/contextvm/ts-sdk
- NIP PR #2246 — CVM over Nostr (kind 25910): https://github.com/nostr-protocol/nips/pull/2246
- Show HN: ContextVM – Running MCP over Nostr: https://news.ycombinator.com/item?id=47151294
- dvmcp — earlier MCP-over-Nostr DVM bridge: https://github.com/gzuuus/dvmcp
