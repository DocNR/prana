import { NostrEvent, ClaimState, KIND } from "./types";
import { resolveClaim } from "./claimResolver";
import { verifyAll, RawEvent, Verifier } from "./fetch";
import { tagVals } from "./nip34";

/**
 * Claim ingest gate + assembly. Two gates in front of the fold, both here: the
 * signature gate (reused verifyAll) lets the fold trust `pubkey`; the admissibility
 * gate (isAdmissibleClaim) lets it trust `expiration`. now-dependent by necessity —
 * parking is a now-relative threat. See docs/superpowers/specs/2026-06-17-claim-fetch-gate-design.md.
 */

export const MAX_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days; max a claim may hold from now
export const CLOCK_SKEW_SECONDS = 300; // 5 min tolerance for honest clock drift

export interface ClaimFetchResult {
  claims: ClaimState[];
  stats: {
    claimsFetched: number;
    droppedSig: number;
    droppedInadmissible: number;
    admitted: number;
  };
}

/** The admissibility gate. (Built clause-by-clause across the plan; kind + expiration format here.) */
export function isAdmissibleClaim(claim: NostrEvent, now: number, maxTtl: number): boolean {
  if (claim.kind !== KIND.CLAIM) return false;
  const raw = tagVals(claim, "expiration")[0];
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return false; // integer, length-bounded
  if (claim.created_at > now + CLOCK_SKEW_SECONDS) return false; // no future-dating
  return Number(raw) <= now + maxTtl; // park horizon, measured from NOW
}

export function resolveClaimsFromEvents(
  rawClaims: RawEvent[],
  issueIds: string[],
  now: number,
  opts: { verify?: Verifier; maxTtl?: number } = {},
): ClaimFetchResult {
  const maxTtl = opts.maxTtl ?? MAX_TTL_SECONDS;
  const verified = verifyAll(rawClaims, opts.verify);
  const admitted = verified.valid.filter((c) => isAdmissibleClaim(c, now, maxTtl));
  const claims = issueIds.map((id) => resolveClaim(id, admitted, now));
  return {
    claims,
    stats: {
      claimsFetched: rawClaims.length,
      droppedSig: verified.dropped,
      droppedInadmissible: verified.valid.length - admitted.length,
      admitted: admitted.length,
    },
  };
}
