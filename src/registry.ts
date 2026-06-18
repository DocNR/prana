import { readFileSync } from "node:fs";
import { ResolvedIssue, KIND } from "./types";
import { SimplePool } from "nostr-tools";
import { discoverAnnouncement, fetchRepo, defaultQuery, poolQuery, QueryFn, Verifier } from "./fetch";
import { WorklistItem, buildWorklist, gatedClaimLookup, ClaimView } from "./worklist";
import { ComplexityScorer, heuristicScorer, Complexity } from "./complexity";
import { buildClaimEvent, ClaimTemplate } from "./claimEvent";
import { repoClone } from "./nip34";

/**
 * The opt-in registry (roadmap #4): the curated set of repos the directory spans.
 *
 * MVP shape is a local curated file (JSON array or NDJSON of RepoRef). The intended
 * end state is a NIP-51 list event of repo coordinates, plus maintainer self-
 * registration — but the consumer here only needs RepoRef[], so swapping the source
 * later (relay-hosted list) doesn't touch the aggregation/render below.
 *
 * This module turns N repos into ONE merged, sorted worklist. It is pure over
 * already-resolved issues — the per-repo fetch/verify/resolve stays in fetch.ts;
 * the live CLI wires those together and feeds the result here.
 */

export interface RepoRef {
  owner: string; // 30617 announcement author pubkey (64-hex)
  d: string; // the repo d-identifier
  name?: string; // optional display label; defaults to `d`
  relays?: string[]; // optional per-repo relay hints (else the announcement's)
}

export const repoRefCoord = (r: RepoRef): string => `30617:${r.owner}:${r.d}`;

const HEX64 = /^[0-9a-f]{64}$/;

function validateRef(raw: unknown, i: number): RepoRef {
  const r = raw as Partial<RepoRef>;
  if (!r || typeof r.owner !== "string" || !HEX64.test(r.owner)) {
    throw new Error(`registry entry ${i}: 'owner' must be a 64-char hex pubkey`);
  }
  if (typeof r.d !== "string" || r.d.length === 0) {
    throw new Error(`registry entry ${i}: 'd' (repo identifier) is required`);
  }
  return { owner: r.owner, d: r.d, name: r.name, relays: r.relays };
}

/** Load a curated registry: a JSON array of RepoRef, or one RepoRef per line. */
export function loadRegistry(path: string): RepoRef[] {
  const text = readFileSync(path, "utf8").trim();
  const rows: unknown[] = text.startsWith("[")
    ? JSON.parse(text)
    : text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (rows.length === 0) throw new Error(`registry at ${path} is empty`);
  return rows.map(validateRef);
}

/** One repo's resolved issues plus its (already-gated) claim lookup, ready to merge. */
export interface RepoInput {
  ref: RepoRef;
  resolved: ResolvedIssue[];
  claimFor?: (issueId: string) => ClaimView | undefined;
  relays?: string[];        // registry-trusted publish targets
  cloneUrl?: string | null; // from the 30617 announcement `clone` tag
}

/** A worklist row tagged with the repo it came from. */
export type MultiRepoItem = WorklistItem & {
  repo: string;
  relays: string[];
  cloneUrl: string | null;
  claimSkeleton: ClaimTemplate | null; // null when not claimable (no relays / non-hex id)
};

const COMPLEXITY_ORDER: Record<Complexity, number> = { S: 0, M: 1, L: 2 };
const isAvailable = (it: MultiRepoItem): boolean => !it.claim || it.claim.holder === null;

/**
 * Merge N repos into one cross-project worklist. Each repo's open issues are scored
 * and claim-tagged by `buildWorklist`, annotated with the repo label, then re-sorted
 * GLOBALLY: available first, then S -> L, so the best quick wins across all repos
 * surface at the top regardless of which repo they live in.
 */
export async function buildMultiRepoWorklist(
  repos: RepoInput[],
  scorer: ComplexityScorer = heuristicScorer,
): Promise<MultiRepoItem[]> {
  const all: MultiRepoItem[] = [];
  for (const r of repos) {
    const label = r.ref.name ?? r.ref.d;
    const items = await buildWorklist(r.resolved, scorer, r.claimFor);
    const relays = r.relays ?? [];
    const cloneUrl = r.cloneUrl ?? null;
    for (const it of items) {
      const claimSkeleton =
        relays.length && HEX64.test(it.issueId) ? buildClaimEvent(it.issueId, { now: 0 }) : null;
      all.push({ ...it, repo: label, relays, cloneUrl, claimSkeleton });
    }
  }
  all.sort((a, b) => {
    const availDiff = Number(isAvailable(b)) - Number(isAvailable(a));
    if (availDiff) return availDiff;
    const cx = COMPLEXITY_ORDER[a.complexity] - COMPLEXITY_ORDER[b.complexity];
    if (cx) return cx;
    if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
    return a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0; // stable
  });
  return all;
}

/** Render the merged worklist with a repo column. */
export function renderMultiRepoWorklist(items: MultiRepoItem[]): string {
  if (items.length === 0) return "no open issues across the registry.";
  const claimLabel = (it: MultiRepoItem): string =>
    isAvailable(it) ? "available" : it.claim!.contended ? "contended" : `claimed:${it.claim!.holder!.slice(0, 8)}`;

  const rows = items.map((i) => ({
    repo: i.repo.length > 16 ? i.repo.slice(0, 15) + "…" : i.repo,
    cx: i.complexity,
    claim: claimLabel(i),
    id: i.issueId.slice(0, 8),
    subject: i.subject.length > 52 ? i.subject.slice(0, 49) + "…" : i.subject,
  }));
  const wRepo = Math.max("repo".length, ...rows.map((r) => r.repo.length));
  const wClaim = Math.max("claim".length, ...rows.map((r) => r.claim.length));
  const wId = Math.max("id".length, ...rows.map((r) => r.id.length));

  const header = `${"repo".padEnd(wRepo)}  S/M/L  ${"claim".padEnd(wClaim)}  ${"id".padEnd(wId)}  subject`;
  const lines = rows.map(
    (r) => `${r.repo.padEnd(wRepo)}    ${r.cx}    ${r.claim.padEnd(wClaim)}  ${r.id.padEnd(wId)}  ${r.subject}`,
  );
  const counts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.complexity] = (acc[i.complexity] ?? 0) + 1;
    return acc;
  }, {});
  const available = items.filter(isAvailable).length;
  const repos = new Set(items.map((i) => i.repo)).size;
  return [
    header,
    ...lines,
    "",
    `${items.length} open across ${repos} repo(s)  (${available} available)  S:${counts.S ?? 0} M:${counts.M ?? 0} L:${counts.L ?? 0}`,
  ].join("\n");
}

/**
 * Live-fetch one registry entry into a RepoInput: discover its announcement, fetch
 * + resolve its issues, then gate-and-fold its claims (kind 31621 by `#d`). Uses the
 * entry's relay hints, falling back to the registry-level relays.
 *
 * NOTE: the claim query mirrors worklist.ts's live path; kept local to avoid a
 * worklist<->registry import cycle. If a third caller appears, hoist it to fetch.ts.
 */
export async function fetchRepoInput(
  ref: RepoRef,
  fallbackRelays: string[] = [],
  now: number = Math.floor(Date.now() / 1000),
  opts: { query?: QueryFn; verify?: Verifier } = {},
): Promise<RepoInput> {
  const relays = ref.relays?.length ? ref.relays : fallbackRelays;
  if (!relays.length) {
    throw new Error(`no relays for ${repoRefCoord(ref)}: add "relays" to the registry entry`);
  }
  // One shared query (and verifier) for THIS repo's discover + issues + claims, so a
  // warm pool from the caller is reused instead of churning a fresh socket per query.
  const query = opts.query ?? defaultQuery;
  const verify = opts.verify;
  const announcement = await discoverAnnouncement(ref.owner, ref.d, relays, { query, verify });
  const resolved = (await fetchRepo(announcement, { relays, query, verify })).resolved;

  const openIds = resolved.filter((r) => r.state === "open").map((r) => r.issue.id);
  let claimFor: ((issueId: string) => ClaimView | undefined) | undefined;
  if (openIds.length) {
    const raw = await query(relays, { kinds: [KIND.CLAIM], "#d": openIds });
    claimFor = gatedClaimLookup(raw, openIds, now, verify ? { verify } : undefined);
  }
  const cloneList = repoClone(announcement);
  const cloneUrl = cloneList.find((u) => u.startsWith("https://")) ?? cloneList[0] ?? null;
  return { ref, resolved, claimFor, relays, cloneUrl };
}

/**
 * Fetch every registry ref through ONE shared query — i.e. one warm SimplePool per
 * run, supplied by the caller — instead of churning a fresh pool per query. A ref
 * that errors is reported and SKIPPED, not fatal, so the directory still renders the
 * repos that resolved. The caller owns the pool lifecycle (close/destroy it once).
 */
export async function fetchRegistryInputs(
  refs: RepoRef[],
  fallbackRelays: string[],
  query: QueryFn,
  verify?: Verifier,
): Promise<RepoInput[]> {
  const inputs: RepoInput[] = [];
  for (const ref of refs) {
    try {
      inputs.push(await fetchRepoInput(ref, fallbackRelays, undefined, { query, verify }));
    } catch (e) {
      console.error(`! skipped ${repoRefCoord(ref)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// CLI:  registry <registry.json> [fallbackRelay...]
// Live-builds the cross-project worklist over every repo in the curated registry.
// A repo that fails to fetch is reported and skipped, not fatal — the directory
// still renders the repos that resolved.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const [registryPath, ...fallbackRelays] = process.argv.slice(2);
  if (!registryPath) throw new Error("usage: registry <registry.json> [fallbackRelay...]");

  const refs = loadRegistry(registryPath);
  const pool = new SimplePool();
  try {
    const inputs = await fetchRegistryInputs(refs, fallbackRelays, poolQuery(pool));
    console.log(renderMultiRepoWorklist(await buildMultiRepoWorklist(inputs)));
  } finally {
    pool.destroy(); // close the warm pool ONCE, at the end of the run
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
