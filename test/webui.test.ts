import { describe, it, expect } from "vitest";
import { renderWorklistHtml, escapeHtml, issueLink } from "../src/webui";
import { MultiRepoItem } from "../src/registry";

function item(over: Partial<MultiRepoItem> = {}): MultiRepoItem {
  return {
    issueId: "a".repeat(64),
    subject: "Fix a thing",
    complexity: "M",
    reasons: [],
    claim: null,
    repo: "ngit",
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
