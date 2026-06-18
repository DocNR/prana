import { NostrEvent, ResolvedIssue, ClaimState, KIND } from "./types";
import { resolveFromEvents, fetchRepo, discoverAnnouncement, RawEvent, Verifier } from "./fetch";
import { resolveClaim } from "./claimResolver";
import { resolveClaimsFromEvents } from "./claimFetch";
import { loadNdjson } from "./nip34";
import { Complexity, ComplexityScorer, heuristicScorer } from "./complexity";

/**
 * The worklist: the contributor-facing view that ties the pieces together.
 *
 *   fetch (verified) -> resolveIssues (correctly-open) -> complexity (S/M/L)
 *                    -> claim fold (available vs taken) -> sorted worklist
 *
 * Claim state comes from the claim fold (`resolveClaim`) via a `claimFor` lookup.
 * `ClaimView` is the display subset of `ClaimState`, so a full `ClaimState` is an
 * acceptable `claimFor` return; when no lookup is supplied, items default to
 * available.
 */

/** Display subset of the claim fold's ClaimState — `ClaimState` satisfies it. */
export interface ClaimView {
  holder: string | null; // canonical claimant pubkey, or null if unclaimed
  expiresAt: number | null;
  contended: boolean;
}

/** A claim lookup over a pool of ALREADY-gated claim events frozen at time `now`.
 *  Pure (no gate) — for callers that have already screened their claims. */
export function claimLookup(claims: NostrEvent[], now: number): (issueId: string) => ClaimState {
  return (issueId) => resolveClaim(issueId, claims, now);
}

/**
 * Claim lookup for UNTRUSTED ingest (CLI / relay / file). Runs raw claim events
 * through the full fetch gate — signature AND admissibility — via
 * `resolveClaimsFromEvents`, so a self-asserted far-future "parking" claim is
 * dropped before the fold sees it. Use THIS, not `claimLookup`, for claims off
 * the wire; feeding unscreened claims to the fold re-opens the I2 parking attack.
 */
export function gatedClaimLookup(
  rawClaims: RawEvent[],
  issueIds: string[],
  now: number,
  opts?: { verify?: Verifier; maxTtl?: number },
): (issueId: string) => ClaimState | undefined {
  const { claims } = resolveClaimsFromEvents(rawClaims, issueIds, now, opts);
  const byId = new Map(issueIds.map((id, i) => [id, claims[i]]));
  return (issueId) => byId.get(issueId);
}

export interface WorklistItem {
  issueId: string;
  subject: string;
  complexity: Complexity;
  reasons: string[];
  claim: ClaimView | null; // null = unclaimed / not yet wired
}

const subjectOf = (issue: NostrEvent): string =>
  issue.tags.find((t) => t[0] === "subject")?.[1] ?? "(no subject)";

const isAvailable = (c: ClaimView | null): boolean => !c || c.holder === null;

const COMPLEXITY_ORDER: Record<Complexity, number> = { S: 0, M: 1, L: 2 };

/**
 * Build the worklist from already-resolved issues. Keeps only open issues
 * (the ones a contributor could actually pick up), scores complexity, attaches
 * claim state, and sorts: available first, then S -> L so quick wins surface.
 */
export async function buildWorklist(
  resolved: ResolvedIssue[],
  scorer: ComplexityScorer = heuristicScorer,
  claimFor?: (issueId: string) => ClaimView | undefined,
): Promise<WorklistItem[]> {
  const open = resolved.filter((r) => r.state === "open");

  const items: WorklistItem[] = [];
  for (const r of open) {
    const signal = await scorer.score(r.issue);
    items.push({
      issueId: r.issue.id,
      subject: subjectOf(r.issue),
      complexity: signal.complexity,
      reasons: signal.reasons,
      claim: claimFor?.(r.issue.id) ?? null,
    });
  }

  items.sort((a, b) => {
    const availDiff = Number(isAvailable(b.claim)) - Number(isAvailable(a.claim));
    if (availDiff) return availDiff; // available (true=1) first
    const cx = COMPLEXITY_ORDER[a.complexity] - COMPLEXITY_ORDER[b.complexity];
    if (cx) return cx;
    return a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0; // stable
  });

  return items;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function claimLabel(c: ClaimView | null): string {
  if (isAvailable(c)) return "available";
  if (c!.contended) return "contended";
  const who = c!.holder!.slice(0, 8);
  return `claimed:${who}`;
}

export function renderWorklist(items: WorklistItem[]): string {
  if (items.length === 0) return "no open issues.";
  const rows = items.map((i) => ({
    cx: i.complexity,
    claim: claimLabel(i.claim),
    id: i.issueId.slice(0, 8),
    subject: i.subject.length > 60 ? i.subject.slice(0, 57) + "…" : i.subject,
  }));
  const wClaim = Math.max("claim".length, ...rows.map((r) => r.claim.length));
  const wId = Math.max("id".length, ...rows.map((r) => r.id.length));

  const header = `S/M/L  ${"claim".padEnd(wClaim)}  ${"id".padEnd(wId)}  subject`;
  const lines = rows.map(
    (r) => `  ${r.cx}    ${r.claim.padEnd(wClaim)}  ${r.id.padEnd(wId)}  ${r.subject}`,
  );
  const counts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.complexity] = (acc[i.complexity] ?? 0) + 1;
    return acc;
  }, {});
  const available = items.filter((i) => isAvailable(i.claim)).length;
  return [
    header,
    ...lines,
    "",
    `${items.length} open  (${available} available)  S:${counts.S ?? 0} M:${counts.M ?? 0} L:${counts.L ?? 0}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI:  worklist file repo.ndjson issues.ndjson [statuses.ndjson] [claims.ndjson]
//       worklist live <ownerPubkey> <d-identifier> <relay> [relay...]
// Claims (kind 31621) are queried by `#d` issue id (the addressable target tag)
// and pass the same verify gate as everything else before the fold sees them.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const [mode, ...rest] = process.argv.slice(2);
  const now = Math.floor(Date.now() / 1000);

  let resolved: ResolvedIssue[];
  let claimFor: ((issueId: string) => ClaimState | undefined) | undefined;

  if (mode === "file") {
    const [repoPath, issuesPath, statusPath, claimsPath] = rest;
    if (!repoPath || !issuesPath) {
      throw new Error("usage: worklist file <repo.ndjson> <issues.ndjson> [statuses.ndjson] [claims.ndjson]");
    }
    const announcement = loadNdjson(repoPath).find((e) => e.kind === KIND.REPO_ANNOUNCEMENT);
    if (!announcement) throw new Error(`no 30617 announcement found in ${repoPath}`);
    const issues = loadNdjson(issuesPath) as RawEvent[];
    const statuses = (statusPath ? loadNdjson(statusPath) : []) as RawEvent[];
    resolved = resolveFromEvents(announcement, issues, statuses).resolved;
    if (claimsPath) {
      const openIds = resolved.filter((r) => r.state === "open").map((r) => r.issue.id);
      claimFor = gatedClaimLookup(loadNdjson(claimsPath) as RawEvent[], openIds, now);
    }
  } else if (mode === "live") {
    const [owner, d, ...relays] = rest;
    if (!owner || !d || relays.length === 0) {
      throw new Error("usage: worklist live <ownerPubkey> <d-identifier> <relay> [relay...]");
    }
    const announcement = await discoverAnnouncement(owner, d, relays);
    resolved = (await fetchRepo(announcement, { relays })).resolved;

    // claims for the issues we'll show, queried by their addressable `#d` id.
    const openIds = resolved.filter((r) => r.state === "open").map((r) => r.issue.id);
    if (openIds.length) {
      const { SimplePool } = await import("nostr-tools");
      const pool = new SimplePool();
      try {
        const raw = (await pool.querySync(relays, { kinds: [KIND.CLAIM], "#d": openIds })) as RawEvent[];
        claimFor = gatedClaimLookup(raw, openIds, now);
      } finally {
        pool.close(relays);
      }
    }
  } else {
    throw new Error("usage: worklist <file|live> ...");
  }

  const items = await buildWorklist(resolved, undefined, claimFor);
  console.log(renderWorklist(items));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
