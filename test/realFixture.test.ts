import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { resolveFromEvents, RawEvent } from "../src/fetch";
import { loadNdjson, issueTargets, tagVals, repoCoord } from "../src/nip34";
import { KIND } from "../src/types";

// Real ngit NIP-34 events captured live (see test/fixtures/ngit/ + its README).
// The events are WHOLE and unedited, so resolveFromEvents runs the REAL
// nostr-tools verifyEvent gate over them here — no injected fake verifier. This
// is the one offline test that proves the security gate works on real signatures
// and that all four data findings reproduce on real event shapes.
const dir = fileURLToPath(new URL("./fixtures/ngit/", import.meta.url));
const repo = loadNdjson(dir + "repo.ndjson").find((e) => e.kind === KIND.REPO_ANNOUNCEMENT)!;
const issues = loadNdjson(dir + "issues.ndjson") as RawEvent[];
const statuses = loadNdjson(dir + "statuses.ndjson") as RawEvent[];

describe("real ngit fixture — live verify gate + all four findings", () => {
  // The co-maintained ngit fork from finding #2 — a sibling 30617 OWNER. Supplied
  // here directly; live euc-group discovery that finds this automatically is Phase 2.
  const A34 = "a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";
  const r = resolveFromEvents(repo, issues, statuses, undefined, [
    { owner: A34, coord: `30617:${A34}:ngit` },
  ]);
  const coord = repoCoord(repo);
  const byId = (p: string) => r.resolved.find((x) => x.issue.id.startsWith(p));

  it("every real signature verifies — the gate drops nothing", () => {
    expect(r.stats.issuesDropped).toBe(0);
    expect(r.stats.statusesDropped).toBe(0);
  });

  it("finding #1: the pure-mention issue (root=rust-nostr) is excluded", () => {
    expect(r.stats.issuesFetched).toBe(7);
    expect(r.stats.issuesBelonging).toBe(6);
    const mention = issues.find((i) => i.id.startsWith("94fd5f6e"))!;
    expect(issueTargets(mention).primary.includes(coord)).toBe(false);
    expect(byId("94fd5f6e")).toBeUndefined(); // never reaches the resolved set
  });

  it("finding #2 x #4: a fork co-owner's close surfaces as a SIGNAL; canonical stays OPEN", () => {
    // a02eac35 carries a real, valid-signature 1632 (Closed) from a34b99f… (the
    // co-maintained fork's owner). It is NOT in this announcement's authority, so
    // canonical state stays Open — but it is now surfaced as a forkSignal a UI can
    // show as "maybe resolved". If a future change unions euc authority, update
    // this test on purpose.
    const forkClosed = byId("a02eac35");
    expect(forkClosed?.state).toBe("open");
    expect(forkClosed?.decidedBy).toBeNull();
    expect(forkClosed?.forkSignal?.state).toBe("closed");
    expect(forkClosed?.forkSignal?.by).toBe(A34);
  });

  it("finding #3: label misspellings survive intact in the raw tags", () => {
    const labeled = issues.find((i) => i.id.startsWith("e977cacb"))!;
    const labels = tagVals(labeled, "t");
    expect(labels).toContain("compati");
    expect(labels).toContain("compatability");
  });

  it("finding #4: authorized status events decide state; statusless defaults Open", () => {
    expect(byId("82eb86fa")?.state).toBe("resolved"); // by maintainer/owner
    expect(byId("3dafc324")?.state).toBe("closed"); // by issue author (self)
    expect(byId("20a2e386")?.state).toBe("open"); // zero status events
    expect(byId("20a2e386")?.decidedBy).toBeNull();
    expect(byId("20a2e386")?.forkSignal).toBeNull(); // no fork owner touched it
  });

  it("status fold honors history: latest valid status wins", () => {
    // 926b76ba has two status events; the later (Closed, by the owner) wins.
    const hist = byId("926b76ba");
    expect(hist?.state).toBe("closed");
    expect(hist?.decidedBy).not.toBeNull();
  });
});
