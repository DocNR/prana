import { describe, it, expect } from "vitest";
import { buildWorklist, renderWorklist, claimLookup, gatedClaimLookup, ClaimView, WorklistItem } from "../src/worklist";
import { ResolvedIssue, NostrEvent, KIND } from "../src/types";
import { RawEvent } from "../src/fetch";
import { MAX_TTL_SECONDS } from "../src/claimFetch";

function resolved(opts: {
  id: string;
  subject: string;
  body?: string;
  state?: ResolvedIssue["state"];
}): ResolvedIssue {
  const issue: NostrEvent = {
    id: opts.id,
    pubkey: "pk",
    created_at: 1_700_000_000,
    kind: KIND.ISSUE,
    tags: [["subject", opts.subject]],
    content: opts.body ?? "",
  };
  return { issue, state: opts.state ?? "open", decidedBy: null, ambiguousTimestamp: false, forkSignal: null };
}

describe("buildWorklist", () => {
  it("drops non-open issues", async () => {
    const items = await buildWorklist([
      resolved({ id: "a", subject: "open one" }),
      resolved({ id: "b", subject: "done one", state: "resolved" }),
    ]);
    expect(items.map((i) => i.issueId)).toEqual(["a"]);
  });

  it("attaches a complexity tag from the scorer", async () => {
    const items = await buildWorklist([
      resolved({ id: "a", subject: "Fix typo in docs", body: "small docs fix" }),
    ]);
    expect(items[0].complexity).toBe("S");
    expect(items[0].reasons.length).toBeGreaterThan(0);
  });

  it("sorts available before claimed, then S -> L", async () => {
    const claims: Record<string, ClaimView> = {
      takenS: { holder: "npubclaimant", expiresAt: 2_000_000_000, contended: false },
    };
    const items = await buildWorklist(
      [
        resolved({ id: "bigL", subject: "Refactor architecture and migrate across all modules", body: "x".repeat(1300) }),
        resolved({ id: "takenS", subject: "typo fix", body: "docs" }),
        resolved({ id: "freeS", subject: "another typo", body: "readme" }),
      ],
      undefined,
      (id) => claims[id],
    );
    // freeS (available, S) first; bigL (available, L) next; takenS (claimed) last
    expect(items.map((i) => i.issueId)).toEqual(["freeS", "bigL", "takenS"]);
  });

  it("defaults claim to null (available) when no lookup is provided", async () => {
    const items = await buildWorklist([resolved({ id: "a", subject: "x" })]);
    expect(items[0].claim).toBeNull();
  });

  it("wires the real resolveClaim fold through claimLookup: an active claim shows claimed", async () => {
    const now = 1_700_000_000;
    const claim: NostrEvent = {
      id: "claim1",
      pubkey: "npubHolder",
      created_at: now - 10,
      kind: KIND.CLAIM,
      tags: [["d", "a"], ["e", "a", "", "root"], ["status", "claimed"], ["expiration", String(now + 3600)]],
      content: "",
    };
    const items = await buildWorklist(
      [resolved({ id: "a", subject: "claimed issue" })],
      undefined,
      claimLookup([claim], now),
    );
    expect(items[0].claim?.holder).toBe("npubHolder");
    expect(renderWorklist(items)).toMatch(/claimed:npubHold/);
  });

  it("an EXPIRED claim reads as available (TTL via the fold)", async () => {
    const now = 1_700_000_000;
    const expired: NostrEvent = {
      id: "claim2",
      pubkey: "npubHolder",
      created_at: now - 7200,
      kind: KIND.CLAIM,
      tags: [["d", "a"], ["status", "claimed"], ["expiration", String(now - 3600)]],
      content: "",
    };
    const items = await buildWorklist(
      [resolved({ id: "a", subject: "stale claim" })],
      undefined,
      claimLookup([expired], now),
    );
    expect(items[0].claim?.holder).toBeNull();
    expect(renderWorklist(items)).toMatch(/available/);
  });
});

describe("worklist claim ingest applies the admissibility gate (I2)", () => {
  const now = 1_700_000_000;
  const fakeVerify = (e: RawEvent) => e.sig === "good";
  const mkClaim = (expiration: number): RawEvent => ({
    id: "c1",
    pubkey: "attacker",
    created_at: now,
    kind: KIND.CLAIM,
    tags: [["d", "a"], ["e", "a", "", "root"], ["status", "claimed"], ["expiration", String(expiration)]],
    content: "",
    sig: "good",
  });

  it("drops a far-future (parking) claim so the issue stays available", () => {
    // the I2 attack: a signed claim with an absurd expiration. The admissibility
    // gate must reject it, unlike a signature-only path which would park the issue.
    const lookup = gatedClaimLookup([mkClaim(now + MAX_TTL_SECONDS * 100)], ["a"], now, { verify: fakeVerify });
    expect(lookup("a")?.holder).toBeNull();
  });

  it("admits an in-horizon claim (the gate discriminates, not blanket-drops)", () => {
    const lookup = gatedClaimLookup([mkClaim(now + 3600)], ["a"], now, { verify: fakeVerify });
    expect(lookup("a")?.holder).toBe("attacker");
  });
});

describe("renderWorklist", () => {
  it("renders a table with a complexity/availability summary", async () => {
    const items: WorklistItem[] = await buildWorklist([
      resolved({ id: "aaaaaaaa1", subject: "Fix typo", body: "docs" }),
      resolved({ id: "bbbbbbbb2", subject: "Refactor everything", body: "refactor across all modules " + "x".repeat(1300) }),
    ]);
    const out = renderWorklist(items);
    expect(out).toMatch(/S\/M\/L/);
    expect(out).toMatch(/2 open  \(2 available\)/);
    expect(out).toMatch(/S:1 M:0 L:1/);
  });

  it("labels a contended claim", async () => {
    const items = await buildWorklist(
      [resolved({ id: "x", subject: "hot issue" })],
      undefined,
      () => ({ holder: "npubA", expiresAt: 2_000_000_000, contended: true }),
    );
    expect(renderWorklist(items)).toMatch(/contended/);
  });

  it("says so when there are no open issues", async () => {
    expect(renderWorklist(await buildWorklist([]))).toBe("no open issues.");
  });
});
