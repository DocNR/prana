import { describe, it, expect } from "vitest";
import { resolveClaim } from "../src/claimResolver";
import { claim, CLAIMER_A, CLAIMER_B } from "./fixtures";

const NOW = 1_700_000_000;
const SOON = 1_700_000_100; // > NOW
const PAST = 1_699_999_900; // < NOW

describe("resolveClaim — basics (target, status, single-claim collapse)", () => {
  it("no claim events => unclaimed", () => {
    const r = resolveClaim("iss1", [], NOW);
    expect(r.holder).toBeNull();
    expect(r.expiresAt).toBeNull();
    expect(r.contended).toBe(false);
    expect(r.active).toEqual([]);
  });

  it("a single active claim => claimed by that pubkey", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const r = resolveClaim("iss1", [c], NOW);
    expect(r.holder).toBe(CLAIMER_A);
    expect(r.expiresAt).toBe(SOON);
    expect(r.contended).toBe(false);
    expect(r.active).toHaveLength(1);
  });

  it("a released claim is not active => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "released" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("a claim with no status tag is treated as claimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON });
    expect(resolveClaim("iss1", [c], NOW).holder).toBe(CLAIMER_A);
  });

  it("a claim targeting issue A does not affect issue B", () => {
    const c = claim({ by: CLAIMER_A, issueId: "issA", at: NOW, expiration: SOON, status: "claimed" });
    expect(resolveClaim("issB", [c], NOW).holder).toBeNull();
  });
});

describe("resolveClaim — expiry / TTL", () => {
  it("an expired claim (now >= expiration) => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: PAST, expiration: PAST, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("a claim with no expiration is not active => unclaimed", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });

  it("boundary: now === expiration => unclaimed (strict <)", () => {
    const c = claim({ by: CLAIMER_A, issueId: "iss1", at: PAST, expiration: NOW, status: "claimed" });
    expect(resolveClaim("iss1", [c], NOW).holder).toBeNull();
  });
});

describe("resolveClaim — per-pubkey replaceability", () => {
  it("refresh: the same pubkey's latest claim wins (not contention)", () => {
    const older = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const newer = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + 10, expiration: SOON + 50, status: "claimed" });
    const r = resolveClaim("iss1", [older, newer], NOW);
    expect(r.holder).toBe(CLAIMER_A);
    expect(r.contended).toBe(false);
    expect(r.expiresAt).toBe(SOON + 50); // the newer expiration
  });

  it("release after claim: a later released event frees the issue", () => {
    const claimed = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const released = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + 10, expiration: SOON, status: "released" });
    expect(resolveClaim("iss1", [claimed, released], NOW).holder).toBeNull();
  });

  it("a claimed and a released at the SAME created_at => released wins (fail-safe), either id order", () => {
    const mk = (claimedId: string, releasedId: string) => [
      claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: claimedId }),
      claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "released", eventId: releasedId }),
    ];
    expect(resolveClaim("iss1", mk("aaaa", "zzzz"), NOW).holder).toBeNull();
    expect(resolveClaim("iss1", mk("zzzz", "aaaa"), NOW).holder).toBeNull();
  });
});

describe("resolveClaim — contention (first-come + surface)", () => {
  it("two pubkeys both active => contended, holder = earliest by created_at", () => {
    const first = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    const second = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW + 10, expiration: SOON, status: "claimed" });
    // pass second-first to defeat an input-order-dependent holder pick
    const r = resolveClaim("iss1", [second, first], NOW);
    expect(r.contended).toBe(true);
    expect(r.holder).toBe(CLAIMER_A); // earliest created_at
    expect(r.active).toHaveLength(2);
  });

  it("contention tie on created_at => deterministic holder by lowest event id", () => {
    const a = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "zzzz" });
    const b = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "aaaa" });
    const r = resolveClaim("iss1", [a, b], NOW);
    expect(r.contended).toBe(true);
    expect(r.holder).toBe(CLAIMER_B); // lowest id "aaaa"
  });

  it("determinism: reversing the input array does not change the result", () => {
    const a = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eventId: "id-a" });
    const b = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW + 5, expiration: SOON, status: "claimed", eventId: "id-b" });
    const r1 = resolveClaim("iss1", [a, b], NOW);
    const r2 = resolveClaim("iss1", [b, a], NOW);
    expect(r1.holder).toBe(r2.holder);
    expect(r1.active.map((c) => c.id)).toEqual(r2.active.map((c) => c.id));
  });
});

describe("resolveClaim — malformed targeting (e-root must equal d)", () => {
  it("a claim whose e-root != d is excluded; a matching one is honored", () => {
    const malformed = claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed", eRoot: "other-issue" });
    expect(resolveClaim("iss1", [malformed], NOW).holder).toBeNull();

    const wellFormed = claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: SOON, status: "claimed" });
    expect(resolveClaim("iss1", [wellFormed], NOW).holder).toBe(CLAIMER_B);
  });
});
