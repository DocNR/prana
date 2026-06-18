import { describe, it, expect } from "vitest";
import { buildClaimEvent, parseTtl, DEFAULT_TTL_SECONDS } from "../src/claim";
import { isAdmissibleClaim, MAX_TTL_SECONDS } from "../src/claimFetch";
import { resolveClaim, claimTargetIssueId } from "../src/claimResolver";
import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { NostrEvent } from "../src/types";

const NOW = 1_700_000_000;
// PRana's own backlog issue #1 — the very issue this command was built for.
const REAL_ISSUE = "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf";

/** Attach a throwaway pubkey/id so a pure template can run through the fold/gate. */
const asEvent = (t: ReturnType<typeof buildClaimEvent>): NostrEvent => ({
  ...t,
  id: "id".padEnd(64, "0"),
  pubkey: "pk".padEnd(64, "0"),
});

describe("buildClaimEvent — shape", () => {
  it("builds a kind-31621 claim with d / e-root / expiration / status tags", () => {
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW, ttlSeconds: 3 * 24 * 3600 });
    expect(t.kind).toBe(31621);
    expect(t.created_at).toBe(NOW);
    expect(t.content).toBe("");
    expect(t.tags).toContainEqual(["d", REAL_ISSUE]);
    expect(t.tags).toContainEqual(["e", REAL_ISSUE, "", "root"]);
    expect(t.tags).toContainEqual(["expiration", String(NOW + 3 * 24 * 3600)]);
    expect(t.tags).toContainEqual(["status", "claimed"]);
  });

  it("e-root equals d so claimTargetIssueId resolves to the issue id", () => {
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW });
    expect(claimTargetIssueId(asEvent(t))).toBe(REAL_ISSUE);
  });

  it("defaults TTL to ~3 days when ttlSeconds omitted", () => {
    expect(DEFAULT_TTL_SECONDS).toBe(3 * 24 * 3600);
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW });
    expect(t.tags).toContainEqual(["expiration", String(NOW + DEFAULT_TTL_SECONDS)]);
  });

  it("expiration is an integer string in the gate's accepted format", () => {
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW });
    const exp = t.tags.find((x) => x[0] === "expiration")![1];
    expect(exp).toMatch(/^\d{1,15}$/);
  });
});

describe("buildClaimEvent — passes the gate and the fold", () => {
  it("a fresh claim is admissible now and when read slightly later", () => {
    const ev = asEvent(buildClaimEvent(REAL_ISSUE, { now: NOW }));
    expect(isAdmissibleClaim(ev, NOW, MAX_TTL_SECONDS)).toBe(true);
    expect(isAdmissibleClaim(ev, NOW + 120, MAX_TTL_SECONDS)).toBe(true);
  });

  it("a signed fresh claim is held by the signer in the fold", () => {
    const sk = generateSecretKey();
    const pk = getPublicKey(sk);
    const signed = finalizeEvent(buildClaimEvent(REAL_ISSUE, { now: NOW }), sk) as NostrEvent;
    const state = resolveClaim(REAL_ISSUE, [signed], NOW);
    expect(state.holder).toBe(pk);
    expect(state.expiresAt).toBe(NOW + DEFAULT_TTL_SECONDS);
    expect(state.contended).toBe(false);
  });
});

describe("buildClaimEvent — release", () => {
  it("release sets status=released, stays admissible, and frees the issue", () => {
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW, release: true });
    expect(t.tags).toContainEqual(["status", "released"]);
    const ev = asEvent(t);
    expect(isAdmissibleClaim(ev, NOW, MAX_TTL_SECONDS)).toBe(true);
    expect(resolveClaim(REAL_ISSUE, [ev], NOW).holder).toBeNull();
  });

  it("a release's expiration is strictly in the future (NIP-40 relays reject expired events)", () => {
    // regression: expiration === created_at publishes a born-expired event; real
    // relays answer "event is expired" and drop it, so the release never lands.
    const t = buildClaimEvent(REAL_ISSUE, { now: NOW, release: true });
    const exp = Number(t.tags.find((x) => x[0] === "expiration")![1]);
    expect(exp).toBeGreaterThan(t.created_at);
  });

  it("claim then a later release by the same signer flips held -> free", () => {
    const sk = generateSecretKey();
    const claimed = finalizeEvent(buildClaimEvent(REAL_ISSUE, { now: NOW }), sk) as NostrEvent;
    const released = finalizeEvent(
      buildClaimEvent(REAL_ISSUE, { now: NOW + 10, release: true }),
      sk,
    ) as NostrEvent;
    expect(resolveClaim(REAL_ISSUE, [claimed], NOW).holder).toBe(getPublicKey(sk));
    expect(resolveClaim(REAL_ISSUE, [claimed, released], NOW).holder).toBeNull();
  });
});

describe("buildClaimEvent — TTL horizon guard", () => {
  it("throws when ttlSeconds exceeds the 14-day horizon", () => {
    expect(() => buildClaimEvent(REAL_ISSUE, { now: NOW, ttlSeconds: MAX_TTL_SECONDS + 1 })).toThrow();
  });

  it("accepts exactly the 14-day horizon (boundary)", () => {
    const ev = asEvent(buildClaimEvent(REAL_ISSUE, { now: NOW, ttlSeconds: MAX_TTL_SECONDS }));
    expect(isAdmissibleClaim(ev, NOW, MAX_TTL_SECONDS)).toBe(true);
  });

  it("rejects an empty issue id", () => {
    expect(() => buildClaimEvent("", { now: NOW })).toThrow();
  });
});

describe("parseTtl", () => {
  it("parses days / hours / minutes / seconds into seconds", () => {
    expect(parseTtl("3d")).toBe(3 * 24 * 3600);
    expect(parseTtl("12h")).toBe(12 * 3600);
    expect(parseTtl("30m")).toBe(30 * 60);
    expect(parseTtl("45s")).toBe(45);
  });

  it("throws on malformed or non-positive input", () => {
    expect(() => parseTtl("abc")).toThrow();
    expect(() => parseTtl("0d")).toThrow();
    expect(() => parseTtl("-5h")).toThrow();
    expect(() => parseTtl("3")).toThrow(); // unit suffix required
  });
});
