import { describe, it, expect } from "vitest";
import { resolveClaimsFromEvents, MAX_TTL_SECONDS, CLOCK_SKEW_SECONDS } from "../src/claimFetch";
import { RawEvent, Verifier } from "../src/fetch";
import { NostrEvent } from "../src/types";
import { claim, CLAIMER_A, CLAIMER_B } from "./fixtures";

const NOW = 1_700_000_000;
const fakeVerify: Verifier = (e) => (e as RawEvent).sig === "good";
const sign = (e: NostrEvent): RawEvent => ({ ...e, sig: "good" });
const forge = (e: NostrEvent): RawEvent => ({ ...e, sig: "bad" });

describe("resolveClaimsFromEvents — sig gate + assembly", () => {
  it("a well-signed, in-horizon claim is admitted; its issue is claimed", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.claims[0].holder).toBe(CLAIMER_A);
    expect(r.stats.droppedSig).toBe(0);
    expect(r.stats.droppedInadmissible).toBe(0);
    expect(r.stats.admitted).toBe(1);
  });

  it("SECURITY: a forged-sig claim is dropped before the fold; issue unclaimed", () => {
    const c = forge(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedSig).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("a released claim is admitted (not dropped) but the issue is unclaimed", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "released" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.admitted).toBe(1);
    expect(r.stats.droppedInadmissible).toBe(0);
    expect(r.claims[0].holder).toBeNull();
  });

  it("batch: claims are routed to the right issue", () => {
    const a = sign(claim({ by: CLAIMER_A, issueId: "issA", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const b = sign(claim({ by: CLAIMER_B, issueId: "issB", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([a, b], ["issA", "issB"], NOW, { verify: fakeVerify });
    expect(r.claims[0].holder).toBe(CLAIMER_A);
    expect(r.claims[1].holder).toBe(CLAIMER_B);
  });
});

describe("resolveClaimsFromEvents — expiration format gate", () => {
  it("a non-integer or oversized expiration is dropped (inadmissible)", () => {
    const hex = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: "0x10", status: "claimed" }));
    const r1 = resolveClaimsFromEvents([hex], ["iss1"], NOW, { verify: fakeVerify });
    expect(r1.stats.droppedInadmissible).toBe(1);
    expect(r1.claims[0].holder).toBeNull();

    const oversized = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: "1234567890123456", status: "claimed" })); // 16 digits
    expect(resolveClaimsFromEvents([oversized], ["iss1"], NOW, { verify: fakeVerify }).stats.droppedInadmissible).toBe(1);
  });

  it("a claim with no expiration tag is dropped (inadmissible)", () => {
    const noExp = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, status: "claimed" }));
    const r = resolveClaimsFromEvents([noExp], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });
});

describe("resolveClaimsFromEvents — park horizon (E <= now + MAX_TTL)", () => {
  it("I2: a far-future expiration (the future-dated parking attack) is dropped", () => {
    const yr = 365 * 24 * 3600;
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + yr, expiration: NOW + yr + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("boundary: E = now + MAX_TTL is admitted; +1 is dropped", () => {
    const ok = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS, status: "claimed" }));
    expect(resolveClaimsFromEvents([ok], ["iss1"], NOW, { verify: fakeVerify }).claims[0].holder).toBe(CLAIMER_A);

    const over = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS + 1, status: "claimed" }));
    const r = resolveClaimsFromEvents([over], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("opts.maxTtl override drops a claim beyond the injected cap", () => {
    const c = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([c], ["iss1"], NOW, { verify: fakeVerify, maxTtl: 500 }); // 1000 > 500
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });

  it("stats: claimsFetched === droppedSig + droppedInadmissible + admitted", () => {
    const good = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const forged = forge(claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: NOW + 1000, status: "claimed" }));
    const overTtl = sign(claim({ by: CLAIMER_B, issueId: "iss1", at: NOW, expiration: NOW + MAX_TTL_SECONDS + 1, status: "claimed" }));
    const r = resolveClaimsFromEvents([good, forged, overTtl], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats).toEqual({ claimsFetched: 3, droppedSig: 1, droppedInadmissible: 1, admitted: 1 });
  });
});

describe("resolveClaimsFromEvents — future-date guard (created_at <= now + CLOCK_SKEW)", () => {
  it("created_at within skew is admitted; beyond skew is dropped (even with a valid expiration)", () => {
    const within = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + CLOCK_SKEW_SECONDS, expiration: NOW + 1000, status: "claimed" }));
    expect(resolveClaimsFromEvents([within], ["iss1"], NOW, { verify: fakeVerify }).claims[0].holder).toBe(CLAIMER_A);

    const beyond = sign(claim({ by: CLAIMER_A, issueId: "iss1", at: NOW + CLOCK_SKEW_SECONDS + 1, expiration: NOW + 1000, status: "claimed" }));
    const r = resolveClaimsFromEvents([beyond], ["iss1"], NOW, { verify: fakeVerify });
    expect(r.stats.droppedInadmissible).toBe(1);
    expect(r.claims[0].holder).toBeNull();
  });
});
