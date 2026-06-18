import { describe, it, expect } from "vitest";
import { renderWorklistHtml, escapeHtml, issueLink, claimRelays, safeClone } from "../src/webui";
import { MultiRepoItem } from "../src/registry";

function item(over: Partial<MultiRepoItem> = {}): MultiRepoItem {
  return {
    issueId: "a".repeat(64),
    subject: "Fix a thing",
    complexity: "M",
    reasons: [],
    claim: null,
    repo: "ngit",
    relays: [],
    cloneUrl: null,
    claimSkeleton: null,
    ...over,
  };
}

describe("escapeHtml / issueLink", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<b>"x"&'</b>`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;");
  });

  it("encodes a valid 64-hex id to an njump note link", () => {
    const link = issueLink("a".repeat(64));
    expect(link).toMatch(/^https:\/\/njump\.me\/note1/);
  });

  it("returns null for an id that isn't a valid event id", () => {
    expect(issueLink("not-hex")).toBeNull();
  });
});

describe("renderWorklistHtml", () => {
  it("renders a row per item with a complexity badge and claim status", () => {
    const html = renderWorklistHtml([
      item({ issueId: "b".repeat(64), subject: "Typo", complexity: "S" }),
      item({ issueId: "c".repeat(64), subject: "Big refactor", complexity: "L", repo: "other", claim: { holder: "npubXXXXYYYY", expiresAt: 2e9, contended: false } }),
    ]);
    expect(html).toMatch(/cx-S/);
    expect(html).toMatch(/cx-L/);
    expect(html).toMatch(/claimed · npubXXXX/);
    expect(html).toMatch(/all repos/);
    expect(html).toMatch(/2 open across 2 repo\(s\)/);
  });

  it("ESCAPES an untrusted subject (no XSS injection)", () => {
    const html = renderWorklistHtml([item({ subject: `<script>alert(1)</script>` })]);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("links a real issue id to njump", () => {
    const html = renderWorklistHtml([item({ issueId: "d".repeat(64) })]);
    expect(html).toMatch(/href="https:\/\/njump\.me\/note1/);
  });

  it("shows an empty state when there are no issues", () => {
    expect(renderWorklistHtml([])).toMatch(/no open issues across the registry/);
  });

  it("builds a repo filter option for each distinct repo", () => {
    const html = renderWorklistHtml([item({ repo: "ngit" }), item({ repo: "zebra" })]);
    expect(html).toMatch(/<option value="ngit">ngit<\/option>/);
    expect(html).toMatch(/<option value="zebra">zebra<\/option>/);
  });
});

describe("claimRelays", () => {
  it("keeps only wss: urls, dedupes, and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`);
    expect(claimRelays(["wss://a", "wss://a", "ws://insecure", "https://x", "not-a-url"]))
      .toEqual(["wss://a"]);
    expect(claimRelays(many)).toHaveLength(8);
  });
});

describe("safeClone", () => {
  it("returns an href for http(s)", () => {
    expect(safeClone("https://example.com/r.git")).toEqual({ kind: "href", url: "https://example.com/r.git" });
  });
  it("returns inert text for nostr:", () => {
    expect(safeClone("nostr://npub1abc/repo")).toEqual({ kind: "text", url: "nostr://npub1abc/repo" });
  });
  it("drops javascript:, data:, vbscript:, and junk (case/space-insensitive)", () => {
    for (const u of ["javascript:alert(1)", "  javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x", "vbscript:x", "nope"])
      expect(safeClone(u)).toBeNull();
  });
});
