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
});
