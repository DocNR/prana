import { describe, it, expect } from "vitest";
import { resolveIssueStatus, openIssues, statusTargetIssueId } from "../src/statusResolver";
import { KIND } from "../src/types";
import { authority, issue, status, AUTHOR, MAINT, OWNER, RANDO, FORK_OWNER, FORK_ADDR } from "./fixtures";

describe("status defaults", () => {
  it("an issue with no status events is Open", () => {
    const i = issue();
    const r = resolveIssueStatus(i, [], authority);
    expect(r.state).toBe("open");
    expect(r.decidedBy).toBeNull();
  });
});

describe("authority: who can set status", () => {
  it("a maintainer can close an issue", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    expect(resolveIssueStatus(i, [s], authority).state).toBe("closed");
  });

  it("the repo owner can resolve an issue", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: OWNER, at: 1_700_000_100 });
    expect(resolveIssueStatus(i, [s], authority).state).toBe("resolved");
  });

  it("the issue author can set their own status", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: AUTHOR, at: 1_700_000_100 });
    expect(resolveIssueStatus(i, [s], authority).state).toBe("closed");
  });

  it("IGNORES a 'resolved' from a random pubkey (the spam/forgery vector)", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: RANDO, at: 1_700_000_100 });
    // unauthorized status must not flip the issue; it stays Open
    expect(resolveIssueStatus(i, [s], authority).state).toBe("open");
  });
});

describe("latest-wins by created_at", () => {
  it("maintainer closes, then author reopens later -> Open", () => {
    const i = issue();
    const closed = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    const reopened = status({ kind: KIND.STATUS_OPEN, issueId: i.id, by: AUTHOR, at: 1_700_000_200 });
    expect(resolveIssueStatus(i, [closed, reopened], authority).state).toBe("open");
  });

  it("order of the input array does not matter (sort by created_at, not arrival)", () => {
    const i = issue();
    const closed = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: MAINT, at: 1_700_000_200 });
    const open = status({ kind: KIND.STATUS_OPEN, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    // pass them "newest first" to try to trick a naive impl
    expect(resolveIssueStatus(i, [closed, open], authority).state).toBe("closed");
  });
});

describe("determinism: created_at ties", () => {
  it("breaks ties deterministically and flags ambiguity", () => {
    const i = issue();
    const a = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: MAINT, at: 1_700_000_100, eventId: "zzzz" });
    const b = status({ kind: KIND.STATUS_OPEN, issueId: i.id, by: MAINT, at: 1_700_000_100, eventId: "aaaa" });
    const r1 = resolveIssueStatus(i, [a, b], authority);
    const r2 = resolveIssueStatus(i, [b, a], authority); // reversed input
    expect(r1.state).toBe(r2.state); // stable regardless of input order
    expect(r1.ambiguousTimestamp).toBe(true);
  });
});

describe("e-tag targeting", () => {
  it("prefers the root-marked e-tag", () => {
    const s = status({ kind: KIND.STATUS_CLOSED, issueId: "issueX", by: MAINT, at: 1 });
    expect(statusTargetIssueId(s)).toBe("issueX");
  });

  it("falls back to a plain e-tag when no root marker is present", () => {
    const s = status({ kind: KIND.STATUS_CLOSED, issueId: "issueY", by: MAINT, at: 1, rootMarker: false });
    expect(statusTargetIssueId(s)).toBe("issueY");
  });

  it("does not let a status for issue A affect issue B", () => {
    const a = issue({ eventId: "issueA" });
    const b = issue({ eventId: "issueB" });
    const closeA = status({ kind: KIND.STATUS_CLOSED, issueId: "issueA", by: MAINT, at: 1_700_000_100 });
    expect(resolveIssueStatus(b, [closeA], authority).state).toBe("open");
    expect(resolveIssueStatus(a, [closeA], authority).state).toBe("closed");
  });
});

describe("openIssues batch filter (what the directory actually shows)", () => {
  it("returns only pickup-able issues", () => {
    const open1 = issue({ eventId: "open1" });
    const open2 = issue({ eventId: "open2" });
    const done = issue({ eventId: "done" });
    const draft = issue({ eventId: "draft" });
    const statuses = [
      status({ kind: KIND.STATUS_RESOLVED, issueId: "done", by: MAINT, at: 1_700_000_100 }),
      status({ kind: KIND.STATUS_DRAFT, issueId: "draft", by: AUTHOR, at: 1_700_000_100 }),
    ];
    const result = openIssues([open1, open2, done, draft], statuses, authority);
    expect(result.map((r) => r.issue.id).sort()).toEqual(["open1", "open2"]);
  });
});

describe("cross-fork signal (finding #2 x #4): surface, do not trust", () => {
  const siblings = [{ owner: FORK_OWNER, coord: FORK_ADDR }];

  it("surfaces a sibling fork owner's status without changing canonical state", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, siblings);
    expect(r.state).toBe("open"); // canonical status is unchanged
    expect(r.decidedBy).toBeNull();
    expect(r.forkSignal).not.toBeNull();
    expect(r.forkSignal?.state).toBe("resolved");
    expect(r.forkSignal?.by).toBe(FORK_OWNER);
    expect(r.forkSignal?.forkCoord).toBe(FORK_ADDR);
  });

  it("does NOT surface a signal from a non-owner third party (owners-only)", () => {
    const i = issue();
    // RANDO is neither canonical authority nor a fork owner -> no signal at all.
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: RANDO, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, siblings);
    expect(r.state).toBe("open");
    expect(r.forkSignal).toBeNull();
  });

  it("does NOT surface a signal from someone already in canonical authority", () => {
    const i = issue();
    // MAINT decides canonically; even if redundantly listed as a fork owner, no double-report.
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority, [{ owner: MAINT, coord: FORK_ADDR }]);
    expect(r.state).toBe("resolved");
    expect(r.decidedBy).not.toBeNull();
    expect(r.forkSignal).toBeNull();
  });

  it("emits no signal when no forkOwners are provided (default behavior unchanged)", () => {
    const i = issue();
    const s = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
    const r = resolveIssueStatus(i, [s], authority);
    expect(r.forkSignal).toBeNull();
  });

  it("takes the fork owner's LATEST status by created_at, regardless of input order", () => {
    const i = issue();
    const older = status({ kind: KIND.STATUS_DRAFT, issueId: i.id, by: FORK_OWNER, at: 1_700_000_100 });
    const newer = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_200 });
    // pass older-first to defeat a naive "first match" implementation.
    const r = resolveIssueStatus(i, [older, newer], authority, [{ owner: FORK_OWNER, coord: FORK_ADDR }]);
    expect(r.forkSignal?.state).toBe("closed");
  });

  it("reports canonical resolution AND an independent fork signal (the two folds don't couple)", () => {
    const i = issue();
    const maintResolve = status({ kind: KIND.STATUS_RESOLVED, issueId: i.id, by: MAINT, at: 1_700_000_100 });
    const forkClose = status({ kind: KIND.STATUS_CLOSED, issueId: i.id, by: FORK_OWNER, at: 1_700_000_150 });
    const r = resolveIssueStatus(i, [maintResolve, forkClose], authority, [{ owner: FORK_OWNER, coord: FORK_ADDR }]);
    expect(r.state).toBe("resolved"); // canonical decided by the maintainer
    expect(r.decidedBy).not.toBeNull();
    expect(r.forkSignal?.state).toBe("closed"); // fork signal computed independently, in parallel
    expect(r.forkSignal?.by).toBe(FORK_OWNER);
  });
});
