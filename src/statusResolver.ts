import {
  NostrEvent,
  RepoAuthority,
  ResolvedIssue,
  IssueState,
  ForkOwner,
  ForkSignal,
  STATUS_KINDS,
  kindToState,
  KIND,
} from "./types";

/**
 * NIP-34 status resolution.
 *
 * Spec rules encoded here (https://nips.nostr.com/34 "Status"):
 *  - An issue (kind 1621) has NO embedded status. Its state is whatever the
 *    most recent (by created_at) VALID status event says.
 *  - A status event is VALID only if signed by the issue author OR a
 *    "recognized maintainer" (repo owner + the 30617 `maintainers` list).
 *  - Status events are kinds 1630 (Open) / 1631 (Resolved) / 1632 (Closed) /
 *    1633 (Draft) and reference the issue via an `e` tag (root marker).
 *  - If there is no valid status event, status DEFAULTS to Open.
 *
 * SECURITY: this function trusts `event.pubkey`. Callers MUST verify event
 * signatures at ingest, or a spammer can forge a "resolved" from a maintainer
 * pubkey. The resolver is intentionally pure/deterministic and does no I/O.
 *
 * DETERMINISM: created_at is attacker-controllable (it's just a number in a
 * signed event). Two valid status events CAN share a created_at. We break ties
 * by lexicographic event id so the result is stable across runs/machines, and
 * flag it via `ambiguousTimestamp` so a UI can warn rather than silently pick.
 */

/** Extract the issue id a status event targets, preferring the root-marked e-tag. */
export function statusTargetIssueId(status: NostrEvent): string | null {
  let rootE: string | null = null;
  let anyE: string | null = null;
  for (const tag of status.tags) {
    if (tag[0] !== "e" || !tag[1]) continue;
    if (anyE === null) anyE = tag[1];
    if (tag[3] === "root") rootE = tag[1];
  }
  return rootE ?? anyE;
}

function isAuthorized(statusPubkey: string, issueAuthor: string, authority: RepoAuthority): boolean {
  if (statusPubkey === issueAuthor) return true;
  if (statusPubkey === authority.owner) return true;
  return authority.maintainers.includes(statusPubkey);
}

/** Pick the winning status event for one issue from its candidate status events. */
function pickWinner(
  issue: NostrEvent,
  candidates: NostrEvent[],
  authority: RepoAuthority,
): { winner: NostrEvent | null; ambiguous: boolean } {
  const valid = candidates.filter(
    (s) =>
      STATUS_KINDS.has(s.kind) &&
      statusTargetIssueId(s) === issue.id &&
      isAuthorized(s.pubkey, issue.pubkey, authority),
  );
  if (valid.length === 0) return { winner: null, ambiguous: false };

  // newest created_at wins; tie-break by event id for determinism.
  valid.sort((a, b) =>
    b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const winner = valid[0];
  const ambiguous =
    valid.length > 1 && valid[1].created_at === winner.created_at;
  return { winner, ambiguous };
}

/**
 * The cross-fork SIGNAL (finding #2 x #4). NIP-34 repos are co-maintained across
 * fork pubkeys grouped by `euc`; a sibling fork's OWNER can legitimately resolve
 * an issue, but they are not in THIS announcement's authority, so the resolver
 * (correctly) won't change canonical state. We surface their latest status here
 * so a UI can flag it, without trusting it.
 *
 * Owners only, by design: `forkOwners` carries sibling 30617 *owners*, never
 * their self-listed maintainers (which are spoofable). A fork owner who is also
 * canonical authority is excluded — their status already counted in pickWinner.
 */
function pickForkSignal(
  issue: NostrEvent,
  candidates: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[],
): ForkSignal | null {
  if (forkOwners.length === 0) return null;
  const coordByOwner = new Map(forkOwners.map((f) => [f.owner, f.coord]));
  const signals = candidates.filter(
    (s) =>
      STATUS_KINDS.has(s.kind) &&
      statusTargetIssueId(s) === issue.id &&
      coordByOwner.has(s.pubkey) && // a sibling fork OWNER
      !isAuthorized(s.pubkey, issue.pubkey, authority), // not already canonical
  );
  if (signals.length === 0) return null;
  // newest created_at wins; tie-break by event id for determinism (as pickWinner).
  signals.sort((a, b) =>
    b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const s = signals[0];
  return {
    state: kindToState(s.kind)!,
    by: s.pubkey,
    forkCoord: coordByOwner.get(s.pubkey)!,
    at: s.created_at,
    event: s,
  };
}

export function resolveIssueStatus(
  issue: NostrEvent,
  statusEvents: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[] = [],
): ResolvedIssue {
  const { winner, ambiguous } = pickWinner(issue, statusEvents, authority);
  const state: IssueState = winner ? kindToState(winner.kind)! : "open"; // default Open
  return {
    issue,
    state,
    decidedBy: winner,
    ambiguousTimestamp: ambiguous,
    forkSignal: pickForkSignal(issue, statusEvents, authority, forkOwners),
  };
}

/** Resolve a batch of issues against a shared pool of status events. */
export function resolveIssues(
  issues: NostrEvent[],
  statusEvents: NostrEvent[],
  authority: RepoAuthority,
  forkOwners: ForkOwner[] = [],
): ResolvedIssue[] {
  // index statuses by target issue id once, so this is O(issues + statuses).
  const byIssue = new Map<string, NostrEvent[]>();
  for (const s of statusEvents) {
    if (!STATUS_KINDS.has(s.kind)) continue;
    const target = statusTargetIssueId(s);
    if (!target) continue;
    (byIssue.get(target) ?? byIssue.set(target, []).get(target)!).push(s);
  }
  return issues
    .filter((i) => i.kind === KIND.ISSUE)
    .map((i) => resolveIssueStatus(i, byIssue.get(i.id) ?? [], authority, forkOwners));
}

/** Convenience: just the issues a contributor could actually pick up. */
export function openIssues(
  issues: NostrEvent[],
  statusEvents: NostrEvent[],
  authority: RepoAuthority,
): ResolvedIssue[] {
  return resolveIssues(issues, statusEvents, authority).filter(
    (r) => r.state === "open",
  );
}
