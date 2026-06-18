# Dogfooding PRana with PRana

The most on-thesis test we can run: publish **PRana itself** as a NIP-34 repo, post
its own backlog as NIP-34 issues, register it in PRana, and route work off the
worklist. The loop closes — every rough edge shows up as an item in its own list,
and fixing the top item (the claim-publish command) is the first thing you dogfood.

PRana is already public on GitHub, so announcing it to Nostr via `ngit` carries no
privacy decision (unlike a private app). Run the kickoff prompt at the bottom in a
local session that has `ngit`, `nak`, `jq`, and your nostr key.

---

## The backlog (ready-to-publish NIP-34 issues)

Each entry below becomes one **kind-1621** event. Required tags:

- `["a", "30617:<OWNER>:<D>", "<RELAY>", "root"]` — the `root` marker makes it *belong*
  to the repo (finding #1: a bare `mention` would be excluded by `issueTargets()`).
- `["subject", "<Subject>"]`
- optional `["t", "<label>"]` labels (these do **not** drive complexity — finding #3)
- `content` = the body.

`<OWNER>`/`<D>`/`<RELAY>` come from PRana's own `30617` announcement after `ngit init`.

The **Intended size** is the human call. After publishing, compare it to the S/M/L the
heuristic scorer assigns — agreement validates the heuristic; "everything came out M"
is the signal to turn on the LLM scorer (issue 3, which is itself in this list).

---

### 1. Claim-publish command (`npm run claim`)  ·  intended **M**  ·  `t: enhancement`

**Subject:** `Add a claim-publish command (claim / refresh / release)`

```
PRana can READ claims (the fold + admissibility gate are done and tested) but there
is no way to WRITE one yet, so claiming an issue is a hand-rolled `nak` one-liner.
This is the missing write-half of roadmap item #2 and the first thing a contributor
hits when they try to actually pick up work.

Add a small command that publishes a kind-31621 claim for a given issue id:

- claim:   publish a 31621 with `["d", <issueId>]`, `["expiration", <now+TTL>]`,
           `["status", "claimed"]`. Default TTL ~3 days, capped at the 14-day park
           horizon the gate already enforces.
- refresh: re-publish with a newer created_at to extend a still-held claim.
- release: publish `["status", "released"]` (or a near-immediate expiration) so the
           issue returns to available without waiting out the TTL.

Acceptance:
- [ ] `npm run claim <issueId> [--ttl 3d|--release]` publishes a valid, signed event
- [ ] the published event passes `isAdmissibleClaim` and flips the worklist to claimed
```

### 2. CVM front door — expose the worklist over MCP-over-Nostr  ·  intended **L**  ·  `t: enhancement`

**Subject:** `Expose the worklist as an MCP server over Nostr (ContextVM)`

```
The big bet (docs/contextvm-fit.md): let an agent discover, claim, and resolve work
over MCP-over-Nostr instead of a web page — so idle subscription capacity can be
pointed at the backlog programmatically. This rides the claim fold we already have
and the claim-publish command (issue #1); sequence it behind those, do not gate on
whether the CVM NIP is merged upstream.

Scope is a vertical slice, not the whole protocol surface:

- [ ] expose `worklist.list` — the same buildMultiRepoWorklist output, as an MCP tool
- [ ] expose `worklist.claim` / `worklist.release` — backed by the claim-publish path
- [ ] expose `worklist.status` — read a single issue's resolved state + claim
- [ ] transport over Nostr per the ContextVM mapping; document the kinds used
- [ ] an end-to-end test: list -> claim -> see it claimed -> release

This is the slice that turns "a directory you browse" into "a backlog agents work
off of," and it is the piece worth showing to the ContextVM author.
```

### 3. LLM complexity scorer  ·  intended **M**  ·  `t: enhancement`

**Subject:** `Add an LLM-backed ComplexityScorer (with heuristic fallback)`

```
The default scorer is a deterministic heuristic; real labels are too sparse to derive
size from (finding #3). Implement an LLM-backed scorer behind the existing
`ComplexityScorer` interface that reads the issue subject + body (and later linked-diff
size) and returns an S/M/L `ComplexitySignal` with reasons.

Acceptance:
- [ ] same interface as `heuristicScorer`; the worklist is agnostic to which it gets
- [ ] falls back to the heuristic when no API key is present, so offline still works
- [ ] caches by issue id so a re-render does not re-spend tokens
```

### 4. Live euc-group sibling discovery  ·  intended **M**  ·  `t: enhancement`

**Subject:** `Discover fork siblings live by euc, to populate forkSignal`

```
The resolver can SURFACE a sibling fork owner's status as a non-authoritative
forkSignal, but nothing discovers those siblings live yet — `fetch live` passes no
siblings, so forkSignal is always null in production (finding #2, Phase 2 in
docs/handoff.md). Query relays by the announcement's `euc` to find sibling repo
owners and feed them to the resolver.

Acceptance:
- [ ] given a repo announcement, find other 30617s sharing its euc
- [ ] pass their owners as the resolver's fork-owner set so forkSignal populates
- [ ] dedupe so the same repo is never listed twice (group on euc, not coord)
```

### 5. Claim button in the web UI  ·  intended **M**  ·  `t: enhancement`

**Subject:** `Wire a claim button in the worklist web UI`

```
The web UI is read-only today. Once the claim-publish command (issue #1) exists, add
a per-row claim affordance that publishes a claim and reflects the new state on the
next render. Keep it honest about signing: it needs the user's key, so gate it behind
a clear "this publishes a signed event" confirmation.

Depends on issue #1.

Acceptance:
- [ ] available rows show a claim control; claimed/contended rows show holder + expiry
- [ ] clicking it publishes a claim and the row flips to claimed on refresh
```

### 6. Registry from a NIP-51 list event  ·  intended **M**  ·  `t: enhancement`

**Subject:** `Load the registry from a NIP-51 list instead of a local file`

```
The registry source is a local JSON file today (roadmap #4 MVP). Add an alternate
source that reads a NIP-51 list event of repo coordinates from relays, so the curated
set can live on Nostr and be updated without editing a file. loadRegistry already
returns RepoRef[]; only the source swaps, the rest of the pipeline is unchanged.

Acceptance:
- [ ] given a list event coordinate, fetch it and parse repo coords into RepoRef[]
- [ ] signature-verify the list event before trusting its contents
- [ ] the existing local-file source keeps working as the offline default
```

### 7. Per-repo clone deep-link in the web UI  ·  intended **S**  ·  `t: enhancement`

**Subject:** `Add a clone-url deep-link per repo in the web UI`

```
Thread the announcement's `clone` tag through so each repo row links to its clone url.
Small, self-contained.
```

### 8. Chunk relay filters for large backlogs  ·  intended **S**  ·  `t: enhancement`

**Subject:** `Batch #e/#d relay filters so large backlogs do not blow the REQ`

```
Claim/status queries put every open issue id into one filter. For a big backlog that
filter gets oversized; batch the ids into chunked REQs and merge. Small, mechanical.
```

---

## Making the code cloneable (the `clone` URL)

PRana reads only metadata, so the worklist / status / claim pipeline works even if the
code stays private. But a contributor who *claims* an issue has to clone it — so the
announcement's `clone` tag must point at code they can actually reach. Two options, and
the announcement may carry **both**:

- **Public GitHub** — the simplest working clone URL. PRana is the open tool itself, so
  this is a no-brainer; flip the repo public first (after a secrets/PII scan of the full
  git history, not just the working tree).
- **GRASP server** — a Nostr-native git host that stores the repo objects so it is
  cloneable straight from Nostr infrastructure (e.g. `relay.ngit.dev`), with no GitHub
  dependency. `ngit init` can push to one. The fully-decentralized, on-thesis option for
  an ngit project — worth adding so a Nostr tool isn't silently leaning on GitHub.

If the `clone` URL points at a private repo, the directory leads a contributor to a wall
— which is exactly what backlog issue #7 (clone deep-link) is about surfacing.

## Kickoff prompt

Paste this into a local Claude Code session at `~/PRana` (needs `ngit`, `nak`, `jq`,
and your nostr key configured):

> I want to dogfood PRana by self-hosting its backlog on Nostr. PRana is at `~/PRana`
> and is already a public repo, so announcing it to Nostr is fine. Read
> `docs/dogfood.md` — it has 8 ready-to-publish issue drafts and the exact tag shape.
>
> Work step by step and pause before anything that publishes to relays:
>
> 1. Check whether `~/PRana` is already ngit-initialized / has a `30617` announcement.
>    If not, run `ngit init` to announce it. Show me the relays it will publish to, the
>    **clone URL(s) it will advertise** (point these at the PUBLIC GitHub https URL, and
>    optionally add a GRASP remote — see "Making the code cloneable" above), and the
>    resulting repo coordinate — owner pubkey (hex), `d`-identifier, relays — and wait
>    for my OK before publishing anything further.
>
> 2. After I approve, publish the 8 issues from `docs/dogfood.md` as **kind-1621**
>    events. Each one needs `["a","30617:<OWNER>:<D>","<RELAY>","root"]` (root marker —
>    must belong, not mention), `["subject", ...]`, the listed `t` label, and the body
>    as content. Use `nak` (check `nak event --help` for the multi-value `a` tag syntax,
>    semicolon-separated) or gitworkshop.dev's new-issue form. Print each event id.
>
> 3. Append a PRana entry to `~/PRana/registry.json`:
>    `{ "name": "prana", "owner": "<OWNER>", "d": "<D>", "relays": [<RELAY>...] }`.
>    Keep the existing ngit entry.
>
> 4. `npm install` if needed, then `npm run registry registry.json` and
>    `npm run serve registry.json`. Open http://localhost:8787 and confirm all 8
>    PRana issues appear, every one shows **open**, and each has an S/M/L tag.
>    Compare the assigned sizes to the "intended size" column in `docs/dogfood.md` and
>    tell me: does the heuristic agree, or did most land on M (meaning we should ship
>    the LLM scorer, issue #3)?
>
> 5. Exercise the STATUS fold on real data (and settle finding #4). Resolve or close
>    ONE of the published issues using a real NIP-34 client — gitworkshop.dev over this
>    same repo is the authentic path (the ngit ecosystem files issues / changes status
>    there). Then re-run `npm run registry registry.json` and confirm that issue flips
>    from open to resolved/closed in the worklist. Capture the raw status event(s) it
>    emitted (kind + tags) and tell me: are closures tracked via 1630-1633 as the
>    resolver assumes, or via some other mechanism? This is the only way to answer
>    finding #4 — do it on the repo we own.
>
> 6. Finally, publish ONE claim to test the claim column end-to-end: a **kind-31621**
>    event with `["d","<issueId of the claim-publish issue #1>"]`,
>    `["expiration","<unix now + 3 days>"]`, `["status","claimed"]`. Show me the exact
>    `nak` command first, then publish and confirm the worklist flips that row to
>    `claimed`. (This is also a live preview of issue #1 — the very thing we'd build
>    first, claimed in PRana itself.)
>
> Report what worked, the S/M/L distribution vs intended, and anything that looked off.
> Do not push changes to the PRana repo or publish to Nostr without my explicit OK.
