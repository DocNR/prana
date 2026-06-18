import { NostrEvent, RepoAuthority, KIND } from "./types";
import { resolveIssues } from "./statusResolver";
import { loadNdjson, tagVals, repoCoord, repoEuc, repoAuthority, issueTargets } from "./nip34";

// ---- load ----
const [repoPath, issuesPath, statusPath] = process.argv.slice(2);
const repo = loadNdjson(repoPath).find((e) => e.kind === KIND.REPO_ANNOUNCEMENT)!;
const allIssues = loadNdjson(issuesPath).filter((e) => e.kind === KIND.ISSUE);
const statuses = statusPath ? loadNdjson(statusPath) : [];

const coord = repoCoord(repo);
const euc = repoEuc(repo);
const authority: RepoAuthority = repoAuthority(repo);

// ---- finding 1: mention vs root (false positives from `-t a=` filter) ----
const belongs = allIssues.filter((i) => issueTargets(i).primary.includes(coord));
const onlyMentions = allIssues.filter(
  (i) => !issueTargets(i).primary.includes(coord) && i.tags.some((t) => t[0] === "a" && t[1] === coord),
);

// ---- finding 2: fork grouping — distinct coordinates seen under same repo-id ----
const repoId = tagVals(repo, "d")[0];
const coords = new Set<string>();
for (const i of allIssues)
  for (const t of i.tags)
    if (t[0] === "a" && t[1]?.endsWith(`:${repoId}`)) coords.add(t[1]);

// ---- finding 3: label hygiene ----
const labelFreq = new Map<string, number>();
let unlabeled = 0;
for (const i of belongs) {
  const ls = tagVals(i, "t");
  if (ls.length === 0) unlabeled++;
  for (const l of ls) labelFreq.set(l, (labelFreq.get(l) ?? 0) + 1);
}

// ---- finding 4: resolved status (the default-Open trap) ----
const resolved = resolveIssues(belongs, statuses, authority);
const byState = resolved.reduce<Record<string, number>>((acc, r) => {
  acc[r.state] = (acc[r.state] ?? 0) + 1;
  return acc;
}, {});

// ---- report ----
console.log(`repo coord : ${coord}`);
console.log(`euc group  : ${euc}`);
console.log(`maintainers: ${authority.maintainers.length} (from announcement)`);
console.log("");
console.log(`issues pulled            : ${allIssues.length}`);
console.log(`  belong to this repo    : ${belongs.length}`);
console.log(`  only MENTION this repo : ${onlyMentions.length}  <- false positives from -t a= filter`);
onlyMentions.forEach((i) =>
  console.log(`     mention: "${tagVals(i, "subject")[0]}" (root=${issueTargets(i).primary.join(",")})`),
);
console.log("");
console.log(`distinct coordinates for repo-id "${repoId}": ${coords.size}  <- fork/co-maintainer grouping`);
coords.forEach((c) => console.log(`     ${c}`));
console.log("");
console.log(`resolved status of belonging issues: ${JSON.stringify(byState)}`);
console.log(`  (no status events => everything defaults Open; that's the trap)`);
console.log("");
console.log(`unlabeled issues: ${unlabeled}/${belongs.length}`);
console.log(`label frequency : ${JSON.stringify(Object.fromEntries([...labelFreq].sort((a, b) => b[1] - a[1])))}`);
