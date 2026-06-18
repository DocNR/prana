# ngit real-event fixture

A trimmed, **real** NIP-34 snapshot of the `ngit` repo, captured live on
2026-06-17 from `wss://relay.ngit.dev` + `wss://relay.damus.io` (via `fetch.sh`).
Repo coordinate: `30617:a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d:ngit`.

Consumed by [`test/realFixture.test.ts`](../../realFixture.test.ts), which runs the
**real** `nostr-tools verifyEvent` gate over these events offline — the one test
that proves the security gate works on genuine signatures (not an injected fake).

## Integrity constraint — do not edit events

These are whole, signed events. **Never modify an event's bytes** (fields, tag
order, whitespace) — any change invalidates its schnorr signature and the verify
gate will (correctly) drop it. To change coverage, add or remove *entire* events.

The files are force-tracked despite the global `*.ndjson` ignore — see the
`!test/fixtures/**/*.ndjson` negation in the repo `.gitignore`.

## Contents — 1 announcement, 7 issues, 6 statuses

Each issue was chosen to exercise a specific finding or resolver path:

| issue id (prefix) | demonstrates |
| --- | --- |
| `94fd5f6e` | **finding #1** — pure *mention* (root is `…:rust-nostr`); must be excluded from this repo |
| `e977cacb` | **finding #3** — label misspellings `compati`, `compatability` coexisting |
| `a02eac35` | **finding #2 × #4** — a valid 1632 (Closed) from the co-maintained fork owner `a34b99f…`; not in this announcement's authority, so canonical state stays **open** but it surfaces as a `forkSignal` (see `test/realFixture.test.ts`) |
| `82eb86fa` | finding #4 — Resolved by the maintainer/owner (authorized) |
| `3dafc324` | finding #4 — Closed by the issue author themselves (authorized) |
| `926b76ba` | status **history** — two status events; latest valid (Closed) wins |
| `20a2e386` | the default-Open case — zero status events → defaults Open |

## Regenerating

Re-run `zsh fetch.sh` to capture a fresh full snapshot, then select these same
event ids (or new representatives) into the three ndjson files. Keep the set small
and keep whole events. After regenerating, update the expected states in
`test/realFixture.test.ts` if the upstream data has moved on.
