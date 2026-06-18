import { describe, it, expect } from "vitest";
import { heuristicScore, heuristicScorer } from "../src/complexity";
import { NostrEvent, KIND } from "../src/types";

function issue(subject: string, body: string): NostrEvent {
  return {
    id: "i1",
    pubkey: "pk",
    created_at: 1_700_000_000,
    kind: KIND.ISSUE,
    tags: subject ? [["subject", subject]] : [],
    content: body,
  };
}

describe("heuristicScore — complexity inference", () => {
  it("tags a doc/typo fix as S", () => {
    const r = heuristicScore(issue("Fix typo in README", "small docs fix"));
    expect(r.complexity).toBe("S");
    expect(r.reasons.join(" ")).toMatch(/small-task hints/);
  });

  it("tags a bare/short issue as M by default", () => {
    const r = heuristicScore(issue("Button is misaligned", "The save button is 2px off."));
    expect(r.complexity).toBe("M");
  });

  it("tags a refactor with a checklist as L", () => {
    const body = [
      "We need to refactor the storage layer and migrate the schema across all modules.",
      "",
      "- [ ] design new schema",
      "- [ ] migrate writers",
      "- [ ] migrate readers",
      "- [ ] backfill",
      "x".repeat(1300),
    ].join("\n");
    const r = heuristicScore(issue("Rework storage architecture", body));
    expect(r.complexity).toBe("L");
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  it("is deterministic (same input -> same output)", () => {
    const i = issue("Add migration", "refactor everything");
    expect(heuristicScore(i)).toEqual(heuristicScore(i));
  });

  it("always explains itself with at least one reason", () => {
    const r = heuristicScore(issue("", ""));
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("exposes the scorer through the ComplexityScorer interface", async () => {
    const r = await heuristicScorer.score(issue("Fix typo", "docs"));
    expect(r.complexity).toBe("S");
  });

  // Regression: real PRana issue (kind 1621) published via ngit. The body links to
  // "docs/contextvm-fit.md"; the old substring match read "docs" as a small-task hint
  // and dragged this L-sized issue (5 checklists + "protocol") down to M. Surfaced by
  // dogfooding PRana on its own backlog.
  it("does not read a keyword inside a path as a signal (real ngit issue)", () => {
    const body = [
      "The big bet (docs/contextvm-fit.md): let an agent discover, claim, and resolve work",
      "over MCP-over-Nostr instead of a web page — so idle subscription capacity can be",
      "pointed at the backlog programmatically. This rides the claim fold we already have",
      "and the claim-publish command (issue #1); sequence it behind those, do not gate on",
      "whether the CVM NIP is merged upstream.",
      "",
      "Scope is a vertical slice, not the whole protocol surface:",
      "",
      "- [ ] expose `worklist.list` — the same buildMultiRepoWorklist output, as an MCP tool",
      "- [ ] expose `worklist.claim` / `worklist.release` — backed by the claim-publish path",
      "- [ ] expose `worklist.status` — read a single issue's resolved state + claim",
      "- [ ] transport over Nostr per the ContextVM mapping; document the kinds used",
      "- [ ] an end-to-end test: list -> claim -> see it claimed -> release",
      "",
      "This is the slice that turns \"a directory you browse\" into \"a backlog agents work",
      "off of,\" and it is the piece worth showing to the ContextVM author.",
    ].join("\n");
    const r = heuristicScore(issue("Expose the worklist as an MCP server over Nostr (ContextVM)", body));
    expect(r.complexity).toBe("L");
    expect(r.reasons.join(" ")).not.toMatch(/small-task/);
  });

  it("counts a keyword as a word but not as a path fragment", () => {
    expect(heuristicScore(issue("update the docs", "x")).reasons.join(" ")).toMatch(/small-task hints: docs/);
    expect(heuristicScore(issue("see docs/guide.md", "x")).reasons.join(" ")).not.toMatch(/docs/);
  });
});
