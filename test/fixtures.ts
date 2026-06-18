import { NostrEvent, KIND, RepoAuthority } from "../src/types";

// deterministic fake ids so tie-break tests are reproducible.
let counter = 0;
function id(prefix = "ev"): string {
  counter += 1;
  return `${prefix}${counter.toString().padStart(4, "0")}`;
}

export const OWNER = "npub_owner";
export const MAINT = "npub_maintainer";
export const AUTHOR = "npub_author";
export const RANDO = "npub_rando"; // not author, not maintainer
export const CLAIMER_A = "npub_claimer_a";
export const CLAIMER_B = "npub_claimer_b";

// A sibling fork's OWNER in the same euc group: a legitimate co-maintainer who
// is NOT in this repo's announcement authority. Their status is a signal, not law.
export const FORK_OWNER = "npub_fork_owner";
export const FORK_ADDR = `30617:${FORK_OWNER}:my-repo`;

export const REPO_ADDR = `30617:${OWNER}:my-repo`;

export const authority: RepoAuthority = {
  owner: OWNER,
  maintainers: [MAINT],
};

export function issue(opts: { author?: string; subject?: string; eventId?: string } = {}): NostrEvent {
  return {
    id: opts.eventId ?? id("issue"),
    pubkey: opts.author ?? AUTHOR,
    created_at: 1_700_000_000,
    kind: KIND.ISSUE,
    tags: [
      ["a", REPO_ADDR],
      ["p", OWNER],
      ...(opts.subject ? [["subject", opts.subject]] : []),
    ],
    content: "something is broken",
  };
}

export function status(opts: {
  kind: number;
  issueId: string;
  by: string;
  at: number;
  rootMarker?: boolean; // default true
  eventId?: string;
}): NostrEvent {
  const eTag =
    opts.rootMarker === false
      ? ["e", opts.issueId]
      : ["e", opts.issueId, "", "root"];
  return {
    id: opts.eventId ?? id("status"),
    pubkey: opts.by,
    created_at: opts.at,
    kind: opts.kind,
    tags: [eTag, ["a", REPO_ADDR]],
    content: "",
  };
}

export function claim(opts: {
  by: string;
  issueId: string;
  at: number; // created_at
  expiration?: number | string;
  status?: string; // "claimed" | "released"; omitted => no status tag
  eventId?: string;
  eRoot?: string; // override the e-root tag value (defaults to issueId); for malformed tests
}): NostrEvent {
  const eRoot = opts.eRoot ?? opts.issueId;
  return {
    id: opts.eventId ?? id("claim"),
    pubkey: opts.by,
    created_at: opts.at,
    kind: KIND.CLAIM,
    tags: [
      ["d", opts.issueId],
      ["e", eRoot, "", "root"],
      ...(opts.expiration !== undefined ? [["expiration", String(opts.expiration)]] : []),
      ...(opts.status !== undefined ? [["status", opts.status]] : []),
    ],
    content: "",
  };
}
