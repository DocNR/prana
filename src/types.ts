// Minimal NIP-01 event shape. We only model the fields the resolver reads.
// IMPORTANT: this resolver assumes `pubkey` is authentic — i.e. signatures were
// already verified at ingest. Trusting pubkey without verifying sig is the
// security boundary; see SECURITY note in statusResolver.ts.
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number; // unix seconds
  kind: number;
  tags: string[][];
  content: string;
}

// NIP-34 kinds we care about for status resolution.
export const KIND = {
  REPO_ANNOUNCEMENT: 30617,
  ISSUE: 1621,
  STATUS_OPEN: 1630,
  STATUS_RESOLVED: 1631, // "Applied/Merged" for patches; "Resolved" for issues
  STATUS_CLOSED: 1632,
  STATUS_DRAFT: 1633,
  CLAIM: 31621, // PROVISIONAL addressable claim over a 1621 issue; reserve before cross-client use
} as const;

export const STATUS_KINDS = new Set<number>([
  KIND.STATUS_OPEN,
  KIND.STATUS_RESOLVED,
  KIND.STATUS_CLOSED,
  KIND.STATUS_DRAFT,
]);

export type IssueState = "open" | "resolved" | "closed" | "draft";

export function kindToState(kind: number): IssueState | null {
  switch (kind) {
    case KIND.STATUS_OPEN: return "open";
    case KIND.STATUS_RESOLVED: return "resolved";
    case KIND.STATUS_CLOSED: return "closed";
    case KIND.STATUS_DRAFT: return "draft";
    default: return null;
  }
}

// The "authority set" for an issue = repo owner + listed maintainers + the
// issue author. Only status events signed by one of these pubkeys are valid.
export interface RepoAuthority {
  owner: string;          // pubkey from the 30617 author
  maintainers: string[];  // pubkeys from the 30617 `maintainers` tag
}

// A sibling fork in the same euc group, identified by the pubkey that signed its
// 30617 announcement. Used as the cross-fork SIGNAL set (owners only, by design).
export interface ForkOwner {
  owner: string; // pubkey from a sibling 30617 announcement
  coord: string; // that sibling's coordinate (30617:pubkey:d)
}

// A non-authoritative status assertion from a sibling fork owner. Surfaced so a
// UI can show "fork X marked this resolved" without flipping canonical state.
export interface ForkSignal {
  state: IssueState; // what the fork owner asserted (e.g. "resolved" / "closed")
  by: string;        // the fork owner's pubkey
  forkCoord: string; // the sibling repo coordinate they own
  at: number;        // created_at of the signalling status event
  event: NostrEvent; // the raw status event (audit trail / debugging)
}

export interface ResolvedIssue {
  issue: NostrEvent;
  state: IssueState;
  // the status event that decided it, or null if status defaulted to Open
  decidedBy: NostrEvent | null;
  // true when two valid status events tied on created_at and we broke the tie
  // deterministically by event id. surfaced so callers can flag/ inspect it.
  ambiguousTimestamp: boolean;
  // a sibling fork OWNER (same euc group) asserted a status we do NOT treat as
  // canonical; null when none. See finding #2 x #4 — surface, don't trust.
  forkSignal: ForkSignal | null;
}

export interface ClaimState {
  issueId: string;
  holder: string | null;    // canonical claimant pubkey, or null if unclaimed
  expiresAt: number | null; // holder's expiration (unix seconds), null if unclaimed
  contended: boolean;       // 2+ active claims from different pubkeys
  active: NostrEvent[];     // each active claimant's current claim, sorted (created_at asc, id asc)
}
