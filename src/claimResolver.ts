import { NostrEvent, ClaimState, KIND } from "./types";
import { tagVals } from "./nip34";

/**
 * Pure claim fold (mirrors statusResolver). Trusts `event.pubkey` and `expiration`;
 * signature + TTL admissibility are the fetch gate's job. `now` is injected so the
 * fold stays deterministic and clock-free. See docs/superpowers/specs/2026-06-17-claim-fold-design.md.
 */

/** The issue a claim targets: the addressable `d` tag. `d` is the replaceability
 *  key, so it is authoritative; if an `e`-root tag is also present it MUST equal `d`
 *  (else the claim would occupy a different relay-side slot than the issue it points
 *  at — malformed → excluded). */
export function claimTargetIssueId(claim: NostrEvent): string | null {
  const d = tagVals(claim, "d")[0];
  if (d === undefined) return null;
  const eRoot = claim.tags.find((t) => t[0] === "e" && t[3] === "root")?.[1];
  if (eRoot !== undefined && eRoot !== d) return null; // malformed: e-root != d
  return d;
}

/** Lifecycle status; a bare claim event (no status tag) is a claim. */
function claimStatus(claim: NostrEvent): string {
  return tagVals(claim, "status")[0] ?? "claimed";
}

/** NIP-40 expiration as a number, or null if absent/non-numeric. */
function claimExpiration(claim: NostrEvent): number | null {
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Is claim `a` more "current" than `b` for the same pubkey? Latest created_at;
 *  on a tie, a `released` beats a `claimed` (fail-safe toward unclaimed); then lowest id. */
function isMoreCurrent(a: NostrEvent, b: NostrEvent): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at;
  const aReleased = claimStatus(a) === "released";
  const bReleased = claimStatus(b) === "released";
  if (aReleased !== bReleased) return aReleased; // released supersedes claimed at equal time
  return a.id < b.id; // same status class: deterministic by lowest id
}

/** One current claim per claimant pubkey (addressable replaceability). */
function currentClaimPerPubkey(claims: NostrEvent[]): NostrEvent[] {
  const byPubkey = new Map<string, NostrEvent>();
  for (const c of claims) {
    const prev = byPubkey.get(c.pubkey);
    if (!prev || isMoreCurrent(c, prev)) byPubkey.set(c.pubkey, c);
  }
  return [...byPubkey.values()];
}

export function resolveClaim(issueId: string, claimEvents: NostrEvent[], now: number): ClaimState {
  const mine = claimEvents.filter(
    (c) => c.kind === KIND.CLAIM && claimTargetIssueId(c) === issueId,
  );
  const active = currentClaimPerPubkey(mine)
    .filter((c) => {
      if (claimStatus(c) !== "claimed") return false;
      const exp = claimExpiration(c);
      return exp !== null && now < exp;
    })
    // first-come: earliest created_at is the canonical holder; id breaks ties.
    // (a refresh advances a holder's created_at, so it can yield first-come to an
    // unexpired rival — acceptable: `holder` is advisory and contention is surfaced.)
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (active.length === 0) {
    return { issueId, holder: null, expiresAt: null, contended: false, active: [] };
  }
  const holder = active[0];
  return {
    issueId,
    holder: holder.pubkey,
    expiresAt: claimExpiration(holder),
    contended: active.length > 1,
    active,
  };
}
