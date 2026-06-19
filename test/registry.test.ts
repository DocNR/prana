import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoRef,
  repoRefCoord,
  loadRegistry,
  buildMultiRepoWorklist,
  renderMultiRepoWorklist,
  fetchRepoInput,
  fetchRegistryInputs,
  RepoInput,
  pickMirrorClone,
} from "../src/registry";
import { ResolvedIssue, NostrEvent, KIND } from "../src/types";
import { ClaimView } from "../src/worklist";
import { QueryFn, Verifier } from "../src/fetch";

function resolved(id: string, subject: string, body = "", state: ResolvedIssue["state"] = "open"): ResolvedIssue {
  const issue: NostrEvent = {
    id,
    pubkey: "pk",
    created_at: 1_700_000_000,
    kind: KIND.ISSUE,
    tags: [["subject", subject]],
    content: body,
  };
  return { issue, state, decidedBy: null, ambiguousTimestamp: false, forkSignal: null };
}

const OWNER = "a008def15796fba9a0d6fab04e8fd57089285d9fd505da5a83fe8aad57a3564d";
const tmpFiles: string[] = [];
function writeTmp(name: string, content: string): string {
  const p = join(tmpdir(), `prana-reg-${Date.now()}-${name}`);
  writeFileSync(p, content);
  tmpFiles.push(p);
  return p;
}
afterAll(() => tmpFiles.forEach((p) => rmSync(p, { force: true })));

describe("registry — RepoRef + loadRegistry", () => {
  it("derives a 30617 coordinate", () => {
    expect(repoRefCoord({ owner: OWNER, d: "ngit" })).toBe(`30617:${OWNER}:ngit`);
  });

  it("loads a JSON array of refs", () => {
    const p = writeTmp("ok.json", JSON.stringify([{ name: "ngit", owner: OWNER, d: "ngit" }]));
    const refs = loadRegistry(p);
    expect(refs).toHaveLength(1);
    expect(refs[0].d).toBe("ngit");
  });

  it("loads NDJSON (one ref per line)", () => {
    const p = writeTmp("ok.ndjson", `{"owner":"${OWNER}","d":"a"}\n{"owner":"${OWNER}","d":"b"}\n`);
    expect(loadRegistry(p).map((r) => r.d)).toEqual(["a", "b"]);
  });

  it("rejects a malformed owner pubkey", () => {
    const p = writeTmp("bad.json", JSON.stringify([{ owner: "not-hex", d: "x" }]));
    expect(() => loadRegistry(p)).toThrow(/64-char hex/);
  });

  it("rejects a missing d-identifier", () => {
    const p = writeTmp("bad2.json", JSON.stringify([{ owner: OWNER }]));
    expect(() => loadRegistry(p)).toThrow(/'d'/);
  });
});

describe("buildMultiRepoWorklist — cross-project merge", () => {
  const repos: RepoInput[] = [
    { ref: { owner: OWNER, d: "repoA", name: "alpha" }, resolved: [
      resolved("a-refactor", "Refactor everything across all modules", "x".repeat(1300)),
      resolved("a-done", "shipped", "", "resolved"),
    ] },
    { ref: { owner: OWNER, d: "repoB", name: "beta" }, resolved: [
      resolved("b-typo", "Fix typo in docs", "small docs fix"),
    ] },
  ];

  it("tags each item with its repo and drops non-open issues", async () => {
    const items = await buildMultiRepoWorklist(repos);
    expect(items.map((i) => i.issueId)).not.toContain("a-done");
    expect(items.find((i) => i.issueId === "b-typo")?.repo).toBe("beta");
    expect(items.find((i) => i.issueId === "a-refactor")?.repo).toBe("alpha");
  });

  it("sorts GLOBALLY: quick wins first regardless of repo", async () => {
    const items = await buildMultiRepoWorklist(repos);
    // beta's S typo outranks alpha's L refactor even though alpha is listed first.
    expect(items[0].issueId).toBe("b-typo");
  });

  it("puts claimed issues after available ones across repos", async () => {
    const claims: Record<string, ClaimView> = {
      "b-typo": { holder: "npubX", expiresAt: 2_000_000_000, contended: false },
    };
    const withClaim: RepoInput[] = [
      repos[1] && { ...repos[1], claimFor: (id: string) => claims[id] },
      repos[0],
    ].filter(Boolean) as RepoInput[];
    const items = await buildMultiRepoWorklist(withClaim);
    expect(items[items.length - 1].issueId).toBe("b-typo"); // claimed sinks to bottom
  });
});

describe("renderMultiRepoWorklist", () => {
  it("renders a repo column and an across-repos summary", async () => {
    const items = await buildMultiRepoWorklist([
      { ref: { owner: OWNER, d: "repoA", name: "alpha" }, resolved: [resolved("a1", "Fix typo", "docs")] },
      { ref: { owner: OWNER, d: "repoB", name: "beta" }, resolved: [resolved("b1", "Refactor across all modules", "x".repeat(1300))] },
    ]);
    const out = renderMultiRepoWorklist(items);
    expect(out).toMatch(/repo/);
    expect(out).toMatch(/2 open across 2 repo\(s\)/);
    expect(out).toMatch(/S:1 M:0 L:1/);
  });

  it("handles an empty registry result", () => {
    expect(renderMultiRepoWorklist([])).toMatch(/no open issues across the registry/);
  });

  it("surfaces an unreachable repo line below the worklist (not silently omitted)", async () => {
    const items = await buildMultiRepoWorklist([
      { ref: { owner: OWNER, d: "repoA", name: "alpha" }, resolved: [resolved("a1", "Fix typo", "docs")] },
    ]);
    const out = renderMultiRepoWorklist(items, [
      { ref: { owner: OWNER, d: "ghost", name: "ghost" }, error: "no 30617 for ghost on wss://relay.down" },
    ]);
    expect(out).toMatch(/1 repo\(s\) unreachable/);
    expect(out).toMatch(/ghost/);
    expect(out).toMatch(/wss:\/\/relay\.down/); // the failure reason is shown
  });

  it("surfaces unreachable repos even when no issues resolved", () => {
    const out = renderMultiRepoWorklist([], [
      { ref: { owner: OWNER, d: "ghost" }, error: "relay timeout" },
    ]);
    expect(out).toMatch(/unreachable/);
    expect(out).toMatch(/ghost/);
    expect(out).not.toBe("no open issues across the registry.");
  });
});

describe("fetchRepoInput — query/verify threading (resilience)", () => {
  const ann: NostrEvent = {
    id: "annR",
    pubkey: OWNER,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "ngit"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const acceptAll: Verifier = () => true;

  it("survives a transient discover miss and threads ONE injected query through every sub-query", async () => {
    let discoverCalls = 0;
    const kindsSeen: number[] = [];
    const query: QueryFn = async (_relays, filter) => {
      const k = filter.kinds?.[0];
      if (typeof k === "number") kindsSeen.push(k);
      if (filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT)) {
        discoverCalls += 1;
        return discoverCalls === 1 ? [] : [ann]; // first miss (transient), then hit
      }
      return []; // no issues -> no statuses, no claims
    };

    const input = await fetchRepoInput({ owner: OWNER, d: "ngit" }, ["wss://relay.one"], 0, {
      query,
      verify: acceptAll,
    });

    expect(input.ref.d).toBe("ngit"); // repo resolved, NOT skipped
    expect(discoverCalls).toBe(2); // the transient miss was retried
    expect(input.cloneUrl).toBeNull(); // ann carries no clone tag
  });
});

describe("fetchRegistryInputs — one shared query, no dropped repo (issue 122478d0)", () => {
  const OWNER_B = "b".repeat(64);
  const annA: NostrEvent = {
    id: "annA",
    pubkey: OWNER,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "a"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const annB: NostrEvent = {
    id: "annB",
    pubkey: OWNER_B,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "b"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const acceptAll: Verifier = () => true;

  it("resolves BOTH repos through one shared query even when one repo's discovery transiently misses", async () => {
    let aDiscover = 0;
    const query: QueryFn = async (_relays, filter) => {
      if (filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT)) {
        if (filter["#d"]?.includes("a")) {
          aDiscover += 1;
          return aDiscover === 1 ? [] : [annA]; // repo A: transient miss, then hit
        }
        if (filter["#d"]?.includes("b")) return [annB]; // repo B: immediate hit
      }
      return []; // no issues/statuses/claims for either repo
    };

    const { inputs, unreachable } = await fetchRegistryInputs(
      [{ owner: OWNER, d: "a" }, { owner: OWNER_B, d: "b" }],
      ["wss://relay.one"],
      query,
      acceptAll,
    );

    // The bug: a transient miss dropped a repo, so the worklist showed "1 repo(s)".
    // The fix: BOTH repos resolve -> "2 repo(s)".
    expect(inputs.map((i) => i.ref.d).sort()).toEqual(["a", "b"]);
    expect(unreachable).toEqual([]); // neither repo was genuinely unreachable
    expect(aDiscover).toBe(2); // repo A's transient miss was retried, not skipped
  });
});

describe("fetchRegistryInputs — a genuinely unreachable repo surfaces, not silently dropped", () => {
  const OWNER_B = "b".repeat(64);
  const annB: NostrEvent = {
    id: "annB",
    pubkey: OWNER_B,
    created_at: 2,
    kind: KIND.REPO_ANNOUNCEMENT,
    tags: [["d", "b"], ["relays", "wss://relay.one"]],
    content: "",
  };
  const acceptAll: Verifier = () => true;

  it("returns the reachable repo as an input and the unreachable one as a {ref, error} marker", async () => {
    // repo A: its announcement query is ALWAYS empty (relay down) -> discoverAnnouncement
    //   throws after its one retry. repo B: resolves immediately.
    const query: QueryFn = async (_relays, filter) => {
      if (filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT) && filter["#d"]?.includes("b")) return [annB];
      return []; // repo A discovery always empty; all issue/status/claim queries empty
    };

    const { inputs, unreachable } = await fetchRegistryInputs(
      [{ owner: OWNER, d: "a", name: "alpha" }, { owner: OWNER_B, d: "b" }],
      ["wss://relay.one"],
      query,
      acceptAll,
    );

    expect(inputs.map((i) => i.ref.d)).toEqual(["b"]); // only B resolved
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0].ref.d).toBe("a"); // A is surfaced, NOT silently dropped
    expect(unreachable[0].ref.name).toBe("alpha");
    expect(unreachable[0].error).toMatch(/no 30617/); // carries the failure reason
  });
});

describe("pickMirrorClone — conventional mirror vs grasp server", () => {
  it("picks the conventional mirror, skipping grasp (npub-embedding) URLs", () => {
    expect(pickMirrorClone(["https://github.com/o/r.git", "https://relay.ngit.dev/npub1abc/r.git"]))
      .toBe("https://github.com/o/r.git");
  });
  it("skips a grasp URL even when it is listed first", () => {
    expect(pickMirrorClone(["https://relay.ngit.dev/npub1abc/r.git", "https://codeberg.org/o/r.git"]))
      .toBe("https://codeberg.org/o/r.git");
  });
  it("returns null when every clone URL is a grasp server", () => {
    expect(pickMirrorClone(["https://relay.ngit.dev/npub1abc/r.git", "https://gitnostr.com/npub1abc/r.git"]))
      .toBeNull();
  });
  it("returns null for an empty list", () => {
    expect(pickMirrorClone([])).toBeNull();
  });
});

describe("buildMultiRepoWorklist — relays/cloneUrl/claimSkeleton threading", () => {
  it("carries relays, cloneUrl, and a claim skeleton onto each item", async () => {
    const id = "a".repeat(64);
    const input: RepoInput = {
      ref: { owner: "1".repeat(64), d: "demo", name: "demo" },
      relays: ["wss://relay.one"],
      cloneUrl: "https://demo.example/r.git",
      resolved: [{
        issue: { id, pubkey: "2".repeat(64), created_at: 1, kind: 1621, tags: [["subject", "demo issue"]], content: "" },
        state: "open", decidedBy: null, ambiguousTimestamp: false, forkSignal: null,
      }],
    };
    const items = await buildMultiRepoWorklist([input]);
    expect(items[0].relays).toEqual(["wss://relay.one"]);
    expect(items[0].cloneUrl).toBe("https://demo.example/r.git");
    expect(items[0].claimSkeleton?.tags).toContainEqual(["d", id]);
    expect(items[0].claimSkeleton?.tags).toContainEqual(["e", id, "", "root"]);
  });

  it("carries the repo owner + d coordinate onto each item (for gitworkshop links)", async () => {
    const input: RepoInput = {
      ref: { owner: "1".repeat(64), d: "demo", name: "demo" },
      relays: ["wss://relay.one"],
      resolved: [{
        issue: { id: "a".repeat(64), pubkey: "2".repeat(64), created_at: 1, kind: 1621, tags: [["subject", "x"]], content: "" },
        state: "open", decidedBy: null, ambiguousTimestamp: false, forkSignal: null,
      }],
    };
    const items = await buildMultiRepoWorklist([input]);
    expect(items[0].owner).toBe("1".repeat(64));
    expect(items[0].d).toBe("demo");
  });
});
