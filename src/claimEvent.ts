import { KIND } from "./types";
import { MAX_TTL_SECONDS } from "./claimFetch";

/** Default claim TTL when the CLI is given no `--ttl`. Short by design — a claim is a
 *  soft "I'm on this", not a lease; it should lapse quickly if the worker walks away. */
export const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days

/** An unsigned Nostr event template (NIP-01). Structurally a nostr-tools `EventTemplate`. */
export interface ClaimTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BuildClaimOpts {
  now: number;
  ttlSeconds?: number;
  release?: boolean;
}

export function buildClaimEvent(issueId: string, opts: BuildClaimOpts): ClaimTemplate {
  if (!issueId) throw new Error("issueId is required");
  const release = opts.release ?? false;
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error(`ttlSeconds must be a positive integer (got ${ttl})`);
  }
  if (ttl > MAX_TTL_SECONDS) {
    throw new Error(`ttl ${ttl}s exceeds the ${MAX_TTL_SECONDS}s (14-day) horizon`);
  }
  // Both claim and release carry a FUTURE expiration (now + ttl). A release must NOT
  // expire at/before its own created_at: NIP-40 relays reject already-expired events.
  const expiry = opts.now + ttl;
  return {
    kind: KIND.CLAIM,
    created_at: opts.now,
    tags: [
      ["d", issueId],
      ["e", issueId, "", "root"],
      ["expiration", String(expiry)],
      ["status", release ? "released" : "claimed"],
    ],
    content: "",
  };
}

const TTL_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseTtl(input: string): number {
  const m = /^(\d+)([smhd])$/.exec(input.trim());
  if (!m) throw new Error(`bad --ttl "${input}": use a number + unit, e.g. 3d, 12h, 30m, 45s`);
  const n = Number(m[1]);
  if (n <= 0) throw new Error(`--ttl must be positive (got "${input}")`);
  return n * TTL_UNITS[m[2]];
}
