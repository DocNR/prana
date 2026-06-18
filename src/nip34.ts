// Shared NIP-34 parsing helpers. Pure, I/O-free (except loadNdjson, the one
// explicit file reader). Both analyze.ts and fetch.ts import these so repo-coord
// / authority / target parsing lives in exactly one place.
import { readFileSync } from "node:fs";
import { NostrEvent, RepoAuthority } from "./types";

/** All values for a given tag name, e.g. tagVals(repo, "maintainers"). */
export const tagVals = (e: NostrEvent, k: string): string[] =>
  e.tags.filter((t) => t[0] === k && t[1] !== undefined).map((t) => t[1]);

/** Addressable coordinate of a 30617 announcement: `30617:<pubkey>:<d>`. */
export const repoCoord = (repo: NostrEvent): string =>
  `30617:${repo.pubkey}:${tagVals(repo, "d")[0]}`;

/** earliest-unique-commit, used to group forks/co-maintained copies (finding #2). */
export const repoEuc = (repo: NostrEvent): string | undefined =>
  repo.tags.find((t) => t[0] === "r" && t[2] === "euc")?.[1];

/** The authority set: repo owner (announcement author) + listed maintainers. */
export const repoAuthority = (repo: NostrEvent): RepoAuthority => ({
  owner: repo.pubkey,
  maintainers: tagVals(repo, "maintainers"),
});

/** Query relays advertised by the announcement's `relays` tag(s).
 *  A `relays` tag holds several urls inline: ["relays", "wss://a", "wss://b"].
 *  We tolerate multiple `relays` tags too, and dedupe. Hardcode nothing. */
export function repoRelays(repo: NostrEvent): string[] {
  const out: string[] = [];
  for (const t of repo.tags)
    if (t[0] === "relays") out.push(...t.slice(1).filter(Boolean));
  return [...new Set(out)];
}

/** Clone URL(s) advertised by the announcement's `clone` tag(s) (NIP-34). Like `relays`,
 *  a `clone` tag may hold several urls inline; tolerate multiple tags and dedupe. */
export function repoClone(repo: NostrEvent): string[] {
  const out: string[] = [];
  for (const t of repo.tags)
    if (t[0] === "clone") out.push(...t.slice(1).filter(Boolean));
  return [...new Set(out)];
}

/** Repo coordinate(s) an issue actually BELONGS to vs merely mentions (finding #1).
 *  rule: a root-marked `a` wins; else if any `a`, all of them; else none. */
export function issueTargets(issue: NostrEvent): {
  primary: string[];
  mentions: string[];
} {
  const aTags = issue.tags.filter((t) => t[0] === "a" && t[1]);
  const rooted = aTags.filter((t) => t[3] === "root").map((t) => t[1]);
  if (rooted.length) {
    const mentions = aTags.map((t) => t[1]).filter((v) => !rooted.includes(v));
    return { primary: rooted, mentions };
  }
  return { primary: aTags.map((t) => t[1]), mentions: [] };
}

/** Load newline-delimited JSON events from disk (recorded `nak`/fetch output). */
export function loadNdjson(path: string): NostrEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as NostrEvent);
}
