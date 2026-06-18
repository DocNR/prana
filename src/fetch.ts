import { SimplePool, verifyEvent as nostrVerifyEvent } from "nostr-tools";
import { NostrEvent, RepoAuthority, ResolvedIssue, ForkOwner, KIND, STATUS_KINDS } from "./types";
import { resolveIssues } from "./statusResolver";
import {
  repoCoord,
  repoAuthority,
  repoRelays,
  issueTargets,
  loadNdjson,
} from "./nip34";

/**
 * Live fetch layer for PRana.
 *
 * THE SECURITY BOUNDARY LIVES HERE. The status resolver trusts `event.pubkey`
 * (see SECURITY note in statusResolver.ts) — so a forged "resolved-by-maintainer"
 * event would flip an issue's state IF it ever reached the resolver. This module
 * is the gate that stops it: every event coming off a relay (or out of a recorded
 * ndjson file) is passed through `verifyEvent` and DROPPED on failure before the
 * resolver ever sees it. Verification is injectable only so tests can exercise the
 * gate without real signatures; production uses nostr-tools `verifyEvent`.
 *
 * The fold itself is NOT reimplemented here — we call resolveIssues, keeping the
 * resolver the single source of truth for status logic.
 */

// Events off the wire carry a `sig`; our NostrEvent shape omits it (the resolver
// never reads it). RawEvent is the boundary type before verification.
export type RawEvent = NostrEvent & { sig?: string };

/** A predicate that returns true iff an event's signature is authentic. */
export type Verifier = (e: RawEvent) => boolean;

const defaultVerify: Verifier = (e) => {
  try {
    return nostrVerifyEvent(e as Parameters<typeof nostrVerifyEvent>[0]);
  } catch {
    // malformed event (missing sig/id/etc.) is, for our purposes, unverifiable.
    return false;
  }
};

export interface VerifyResult {
  valid: NostrEvent[];
  dropped: number;
}

/** The gate: keep only events with an authentic signature; count the rejects. */
export function verifyAll(events: RawEvent[], verify: Verifier = defaultVerify): VerifyResult {
  const valid: NostrEvent[] = [];
  let dropped = 0;
  for (const e of events) {
    if (verify(e)) valid.push(e);
    else dropped += 1;
  }
  return { valid, dropped };
}

export interface FetchStats {
  issuesFetched: number;
  issuesDropped: number; // failed signature verification
  issuesBelonging: number; // after excluding pure mentions (finding #1)
  statusesFetched: number;
  statusesDropped: number;
}

export interface FetchResult {
  coord: string;
  authority: RepoAuthority;
  resolved: ResolvedIssue[];
  stats: FetchStats;
}

/** Minimal Nostr REQ filter — just the fields we use. */
export interface Filter {
  kinds?: number[];
  authors?: string[];
  "#a"?: string[];
  "#d"?: string[];
  "#e"?: string[];
}

/** Relay query function. Injectable so the live path can be tested with a mock. */
export type QueryFn = (relays: string[], filter: Filter) => Promise<RawEvent[]>;

export const defaultQuery: QueryFn = async (relays, filter) => {
  const pool = new SimplePool();
  try {
    // our Filter is a structural subset of nostr-tools' (which has a `#<tag>`
    // index signature); cast at this one boundary rather than leak their type.
    const f = filter as Parameters<typeof pool.querySync>[1];
    return (await pool.querySync(relays, f)) as RawEvent[];
  } finally {
    pool.close(relays);
  }
};

/**
 * Build a QueryFn over a caller-owned pool that is REUSED across every query in a
 * run and closed ONCE by the caller (do NOT close per query). The generous
 * `maxWait` gives a slow relay time to answer, so a registry run's connect/
 * disconnect churn can't make a real response land after querySync already
 * resolved empty — the root cause of a repo being silently dropped from the
 * worklist (ngit issue 122478d0).
 */
export function poolQuery(pool: SimplePool, maxWait = 5000): QueryFn {
  return async (relays, filter) => {
    const f = filter as Parameters<typeof pool.querySync>[1];
    return (await pool.querySync(relays, f, { maxWait })) as RawEvent[];
  };
}

/**
 * Pure assembly from already-collected events (recorded ndjson, or a captured
 * snapshot). Verifies, drops mentions, resolves status. No network.
 */
export function resolveFromEvents(
  announcement: NostrEvent,
  rawIssues: RawEvent[],
  rawStatuses: RawEvent[],
  verify: Verifier = defaultVerify,
  forkOwners: ForkOwner[] = [],
): FetchResult {
  const coord = repoCoord(announcement);
  const authority = repoAuthority(announcement);

  const issues = verifyAll(rawIssues, verify);
  // finding #1: keep only issues whose ROOT target is this repo; pure mentions out.
  const belonging = issues.valid.filter((i) => issueTargets(i).primary.includes(coord));

  const statuses = verifyAll(rawStatuses, verify);
  const resolved = resolveIssues(belonging, statuses.valid, authority, forkOwners);

  return {
    coord,
    authority,
    resolved,
    stats: {
      issuesFetched: rawIssues.length,
      issuesDropped: issues.dropped,
      issuesBelonging: belonging.length,
      statusesFetched: rawStatuses.length,
      statusesDropped: statuses.dropped,
    },
  };
}

/**
 * Discover a repo's 30617 announcement by owner + d-identifier, filtering AT THE
 * RELAY (`authors` + `#d`), the way `nak req -k 30617 -a OWNER -d <id>` does.
 *
 * Why not just scan kind:30617 and filter client-side: relays cap an unfiltered
 * pull (observed ~500 newest on relay.ngit.dev). A repo whose announcement isn't
 * among the newest-N globally then falls outside the window, and the client-side
 * filter finds nothing — which is exactly how the live path failed for ngit
 * (announcement ~a year old, well past the cap). Filtering at the relay avoids it.
 *
 * 30617 is addressable/replaceable, so the newest created_at wins (a lagging
 * relay can still serve a stale copy). The result must clear the signature gate
 * before it can seed the authority set the resolver trusts.
 */
export async function discoverAnnouncement(
  owner: string,
  d: string,
  relays: string[],
  opts: { query?: QueryFn; verify?: Verifier } = {},
): Promise<NostrEvent> {
  const query = opts.query ?? defaultQuery;
  const verify = opts.verify ?? defaultVerify;
  const filter: Filter = { kinds: [KIND.REPO_ANNOUNCEMENT], authors: [owner], "#d": [d] };

  // One query attempt -> client-side belt-and-suspenders match -> signature gate.
  const attempt = async (): Promise<NostrEvent[]> => {
    const raw = await query(relays, filter);
    // a relay may ignore the filter, so match client-side too.
    const matching = raw.filter(
      (e) => e.pubkey === owner && e.tags.some((t) => t[0] === "d" && t[1] === d),
    );
    return verifyAll(matching, verify).valid;
  };

  // Retry once: under per-run connect/disconnect churn a slow relay's response can
  // land after the first querySync resolves empty. A bare retry turns that
  // transient miss into a hit instead of silently dropping the whole repo.
  let verified = await attempt();
  if (!verified.length) verified = await attempt();
  if (!verified.length) throw new Error(`no 30617 for ${owner}:${d} on ${relays.join(", ")}`);

  // replaceable: newest wins; tie-break by id so the choice is deterministic.
  verified.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return verified[0];
}

/**
 * Live fetch for one repo, given its (already-verified) 30617 announcement.
 *
 * Relays come from the announcement's `relays` tag unless overridden — we do NOT
 * hardcode relays. Issues are queried by `a`-coordinate, then statuses by the
 * surviving issue ids (the robust path: status events `e`-tag the issue).
 */
export async function fetchRepo(
  announcement: NostrEvent,
  opts: { relays?: string[]; query?: QueryFn; verify?: Verifier; forkOwners?: ForkOwner[] } = {},
): Promise<FetchResult> {
  const coord = repoCoord(announcement);
  const relays = opts.relays?.length ? opts.relays : repoRelays(announcement);
  if (!relays.length) {
    throw new Error(
      `no query relays for ${coord}: the 30617 announcement carries no \`relays\` tag — pass opts.relays`,
    );
  }
  const query = opts.query ?? defaultQuery;
  const verify = opts.verify ?? defaultVerify;

  const rawIssues = await query(relays, { kinds: [KIND.ISSUE], "#a": [coord] });
  const issues = verifyAll(rawIssues, verify);
  const belonging = issues.valid.filter((i) => issueTargets(i).primary.includes(repoCoord(announcement)));

  const ids = belonging.map((i) => i.id);
  // TODO: relays may cap `#e` filter size; chunk ids for very large backlogs.
  const rawStatuses = ids.length
    ? await query(relays, { kinds: [...STATUS_KINDS], "#e": ids })
    : [];
  const statuses = verifyAll(rawStatuses, verify);

  const authority = repoAuthority(announcement);
  const resolved = resolveIssues(belonging, statuses.valid, authority, opts.forkOwners ?? []);

  return {
    coord,
    authority,
    resolved,
    stats: {
      issuesFetched: rawIssues.length,
      issuesDropped: issues.dropped,
      issuesBelonging: belonging.length,
      statusesFetched: rawStatuses.length,
      statusesDropped: statuses.dropped,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI. Two modes:
//   recorded:  tsx src/fetch.ts file repo.ndjson issues.ndjson [statuses.ndjson]
//   live:      tsx src/fetch.ts live <ownerPubkey> <d-identifier> <relay> [relay...]
// Recorded mode runs the SAME verify->resolve pipeline against a captured snapshot
// (e.g. the output of fetch.sh), so it works fully offline.
// ---------------------------------------------------------------------------
function printResult(r: FetchResult): void {
  const byState = r.resolved.reduce<Record<string, number>>((acc, x) => {
    acc[x.state] = (acc[x.state] ?? 0) + 1;
    return acc;
  }, {});
  const ambiguous = r.resolved.filter((x) => x.ambiguousTimestamp).length;
  console.log(`repo coord : ${r.coord}`);
  console.log(`maintainers: ${r.authority.maintainers.length}`);
  console.log("");
  console.log(`issues fetched   : ${r.stats.issuesFetched}`);
  console.log(`  dropped (bad sig): ${r.stats.issuesDropped}`);
  console.log(`  belonging        : ${r.stats.issuesBelonging}  (pure mentions excluded)`);
  console.log(`statuses fetched : ${r.stats.statusesFetched}  (dropped bad sig: ${r.stats.statusesDropped})`);
  console.log("");
  console.log(`resolved state   : ${JSON.stringify(byState)}`);
  if (ambiguous) console.log(`ambiguous ties   : ${ambiguous}  <- two valid statuses tied on created_at`);
}

async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);

  if (mode === "file") {
    const [repoPath, issuesPath, statusPath] = rest;
    if (!repoPath || !issuesPath) {
      throw new Error("usage: fetch.ts file <repo.ndjson> <issues.ndjson> [statuses.ndjson]");
    }
    const announcement = loadNdjson(repoPath).find((e) => e.kind === KIND.REPO_ANNOUNCEMENT);
    if (!announcement) throw new Error(`no 30617 announcement found in ${repoPath}`);
    const issues = loadNdjson(issuesPath) as RawEvent[];
    const statuses = (statusPath ? loadNdjson(statusPath) : []) as RawEvent[];
    printResult(resolveFromEvents(announcement, issues, statuses));
    return;
  }

  if (mode === "live") {
    const [owner, d, ...relays] = rest;
    if (!owner || !d || relays.length === 0) {
      throw new Error("usage: fetch.ts live <ownerPubkey> <d-identifier> <relay> [relay...]");
    }
    // discover AT THE RELAY (authors + #d); see discoverAnnouncement for why an
    // unfiltered scan misses older announcements. Verification happens in there.
    const announcement = await discoverAnnouncement(owner, d, relays);
    printResult(await fetchRepo(announcement, { relays }));
    return;
  }

  throw new Error("usage: fetch.ts <file|live> ...");
}

// run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
