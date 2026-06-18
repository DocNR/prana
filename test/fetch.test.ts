import { describe, it, expect } from "vitest";
import {
  verifyAll,
  resolveFromEvents,
  fetchRepo,
  discoverAnnouncement,
  RawEvent,
  Verifier,
  QueryFn,
} from "../src/fetch";
import { repoRelays, issueTargets } from "../src/nip34";
import { NostrEvent, KIND } from "../src/types";
import { OWNER, MAINT, AUTHOR, RANDO, REPO_ADDR, issue, status } from "./fixtures";

// The announcement the resolver derives authority from. (Owner + one maintainer.)
const announcement: NostrEvent = {
  id: "repo0001",
  pubkey: OWNER,
  created_at: 1_700_000_000,
  kind: KIND.REPO_ANNOUNCEMENT,
  tags: [
    ["d", "my-repo"],
    ["maintainers", MAINT],
    ["relays", "wss://relay.one", "wss://relay.two"],
  ],
  content: "",
};

// A verifier that treats events as forged unless they carry sig === "good".
// Lets us exercise the gate without real schnorr signatures.
const fakeVerify: Verifier = (e: RawEvent) => e.sig === "good";
const sign = (e: NostrEvent): RawEvent => ({ ...e, sig: "good" });
const forge = (e: NostrEvent): RawEvent => ({ ...e, sig: "bad" });

describe("verifyAll — the security gate", () => {
  it("keeps signed events and drops forgeries, counting drops", () => {
    const events = [sign(issue()), forge(issue()), sign(issue())];
    const r = verifyAll(events, fakeVerify);
    expect(r.valid).toHaveLength(2);
    expect(r.dropped).toBe(1);
  });

  it("drops everything when nothing verifies", () => {
    const r = verifyAll([forge(issue()), forge(issue())], fakeVerify);
    expect(r.valid).toHaveLength(0);
    expect(r.dropped).toBe(2);
  });
});

describe("repoRelays — relay discovery (no hardcoding)", () => {
  it("reads the announcement's relays tag", () => {
    expect(repoRelays(announcement)).toEqual(["wss://relay.one", "wss://relay.two"]);
  });

  it("dedupes across multiple relays tags and returns [] when absent", () => {
    const multi = { ...announcement, tags: [["relays", "wss://a"], ["relays", "wss://a", "wss://b"]] };
    expect(repoRelays(multi)).toEqual(["wss://a", "wss://b"]);
    expect(repoRelays({ ...announcement, tags: [["d", "x"]] })).toEqual([]);
  });
});

describe("issueTargets — mention vs root (finding #1)", () => {
  it("prefers a root-marked a-tag and reports others as mentions", () => {
    const i: NostrEvent = {
      ...issue(),
      tags: [
        ["a", "30617:other:repo", "", "mention"],
        ["a", REPO_ADDR, "", "root"],
      ],
    };
    const t = issueTargets(i);
    expect(t.primary).toEqual([REPO_ADDR]);
    expect(t.mentions).toEqual(["30617:other:repo"]);
  });
});

describe("resolveFromEvents — pipeline ties fetch to resolver", () => {
  it("excludes issues that only MENTION this repo", () => {
    const mine = sign(issue({ eventId: "mine" }));
    const mention: RawEvent = sign({
      ...issue({ eventId: "theirs" }),
      tags: [["a", "30617:other:repo", "", "root"], ["a", REPO_ADDR, "", "mention"]],
    });
    const r = resolveFromEvents(announcement, [mine, mention], [], fakeVerify);
    expect(r.stats.issuesFetched).toBe(2);
    expect(r.stats.issuesBelonging).toBe(1);
    expect(r.resolved.map((x) => x.issue.id)).toEqual(["mine"]);
  });

  it("SECURITY: a forged 'resolved' from a maintainer pubkey is dropped, issue stays open", () => {
    const i = issue({ eventId: "i1" });
    // Looks authoritative (maintainer pubkey, real Resolved kind) but the sig is bad.
    const forgedResolve = forge(
      status({ kind: KIND.STATUS_RESOLVED, issueId: "i1", by: MAINT, at: 1_700_000_100 }),
    );
    const r = resolveFromEvents(announcement, [sign(i)], [forgedResolve], fakeVerify);
    expect(r.stats.statusesDropped).toBe(1);
    expect(r.resolved[0].state).toBe("open"); // default-Open held because forgery was gated out
  });

  it("a VALID resolved from a maintainer does flip the issue", () => {
    const i = issue({ eventId: "i2" });
    const realResolve = sign(
      status({ kind: KIND.STATUS_RESOLVED, issueId: "i2", by: MAINT, at: 1_700_000_100 }),
    );
    const r = resolveFromEvents(announcement, [sign(i)], [realResolve], fakeVerify);
    expect(r.stats.statusesDropped).toBe(0);
    expect(r.resolved[0].state).toBe("resolved");
  });

  it("a status from a rando (valid sig, wrong pubkey) does NOT flip the issue", () => {
    const i = issue({ eventId: "i3" });
    const randoResolve = sign(
      status({ kind: KIND.STATUS_RESOLVED, issueId: "i3", by: RANDO, at: 1_700_000_100 }),
    );
    const r = resolveFromEvents(announcement, [sign(i)], [randoResolve], fakeVerify);
    expect(r.stats.statusesDropped).toBe(0); // sig is fine...
    expect(r.resolved[0].state).toBe("open"); // ...but resolver rejects unauthorized pubkey
  });

  it("threads forkOwners through the verify pipeline to surface a fork signal", () => {
    const i = issue({ eventId: "fi1" });
    // RANDO owns a sibling fork; their valid-sig close is a SIGNAL, not canonical.
    const forkClose = sign(
      status({ kind: KIND.STATUS_CLOSED, issueId: "fi1", by: RANDO, at: 1_700_000_100 }),
    );
    const r = resolveFromEvents(announcement, [sign(i)], [forkClose], fakeVerify, [
      { owner: RANDO, coord: `30617:${RANDO}:my-repo` },
    ]);
    expect(r.resolved[0].state).toBe("open"); // canonical unchanged
    expect(r.resolved[0].forkSignal?.state).toBe("closed");
    expect(r.resolved[0].forkSignal?.by).toBe(RANDO);
  });
});

describe("discoverAnnouncement — relay-side author+d filter (live discovery)", () => {
  // A different owner's announcement that a capped unfiltered scan WOULD return.
  const otherRepo: NostrEvent = {
    ...announcement,
    id: "repoOTHER",
    pubkey: "npub_someone_else",
    tags: [["d", "their-repo"], ["relays", "wss://relay.one"]],
  };

  it("finds the target via an author+d filter even when an unfiltered scan would miss it", async () => {
    // Real-world failure (ngit): relays cap an unfiltered kind:30617 pull (~500
    // newest) and an older announcement falls outside that window; a filtered
    // query still returns it. Discovery must filter at the relay, not scan.
    const calls: { filter: { authors?: string[]; "#d"?: string[]; kinds?: number[] } }[] = [];
    const query: QueryFn = async (_relays, filter) => {
      calls.push({ filter });
      if (!filter.kinds?.includes(KIND.REPO_ANNOUNCEMENT)) return [];
      const filtered = filter.authors?.includes(OWNER) && filter["#d"]?.includes("my-repo");
      return filtered ? [sign(announcement)] : [sign(otherRepo)]; // unfiltered => capped set w/o ours
    };
    const found = await discoverAnnouncement(OWNER, "my-repo", ["wss://relay.one"], {
      query,
      verify: fakeVerify,
    });
    expect(found.id).toBe("repo0001");
    // pin the mechanism: discovery filtered at the relay by author + d-tag.
    expect(calls[0].filter.authors).toEqual([OWNER]);
    expect(calls[0].filter["#d"]).toEqual(["my-repo"]);
  });

  it("rejects a forged announcement (keeps the signature gate in front of the resolver)", async () => {
    const query: QueryFn = async () => [forge(announcement)];
    await expect(
      discoverAnnouncement(OWNER, "my-repo", ["wss://relay.one"], { query, verify: fakeVerify }),
    ).rejects.toThrow();
  });

  it("throws a clear error when the target announcement is absent", async () => {
    const query: QueryFn = async () => [];
    await expect(
      discoverAnnouncement(OWNER, "missing", ["wss://relay.one"], { query, verify: fakeVerify }),
    ).rejects.toThrow(/no 30617/);
  });

  it("returns the newest when relays return stale replaceable copies", async () => {
    // 30617 is addressable/replaceable; a lagging relay may still serve an old
    // copy alongside the fresh one. Newest created_at must win.
    const stale = { ...announcement, id: "repoSTALE", created_at: announcement.created_at - 1000 };
    const fresh = { ...announcement, id: "repoFRESH", created_at: announcement.created_at + 1000 };
    const query: QueryFn = async () => [sign(stale), sign(fresh)];
    const found = await discoverAnnouncement(OWNER, "my-repo", ["wss://relay.one"], {
      query,
      verify: fakeVerify,
    });
    expect(found.id).toBe("repoFRESH");
  });
});

describe("fetchRepo — live path with injected query (no network)", () => {
  it("queries by coord, then statuses by surviving issue ids, and resolves", async () => {
    const i = issue({ eventId: "live1" });
    const resolve = status({
      kind: KIND.STATUS_RESOLVED,
      issueId: "live1",
      by: AUTHOR,
      at: 1_700_000_200,
    });
    const calls: { relays: string[]; filter: unknown }[] = [];
    const query: QueryFn = async (relays, filter) => {
      calls.push({ relays, filter });
      if (filter.kinds?.includes(KIND.ISSUE)) return [sign(i)];
      if (filter["#e"]) return [sign(resolve)];
      return [];
    };
    const r = await fetchRepo(announcement, { query, verify: fakeVerify });

    expect(calls[0].relays).toEqual(["wss://relay.one", "wss://relay.two"]); // discovered, not hardcoded
    expect((calls[0].filter as { "#a": string[] })["#a"]).toEqual([REPO_ADDR]);
    expect((calls[1].filter as { "#e": string[] })["#e"]).toEqual(["live1"]);
    expect(r.resolved[0].state).toBe("resolved");
  });

  it("throws when no relays are discoverable and none are provided", async () => {
    const noRelays = { ...announcement, tags: [["d", "my-repo"], ["maintainers", MAINT]] };
    await expect(fetchRepo(noRelays, { verify: fakeVerify })).rejects.toThrow(/no query relays/);
  });

  it("skips the status query entirely when no issues survive", async () => {
    const calls: Filter[] = [];
    type Filter = Parameters<QueryFn>[1];
    const query: QueryFn = async (_relays, filter) => {
      calls.push(filter);
      return []; // no issues come back
    };
    const r = await fetchRepo(announcement, { query, verify: fakeVerify });
    expect(calls).toHaveLength(1); // only the issue query ran
    expect(r.resolved).toHaveLength(0);
  });
});
