import { describe, it, expect } from "vitest";
import { renderWorklistHtml, escapeHtml, issueLink, claimRelays, safeClone } from "../src/webui";
import { MultiRepoItem, UnreachableRepo } from "../src/registry";
import { buildClaimEvent } from "../src/claimEvent";

function item(over: Partial<MultiRepoItem> = {}): MultiRepoItem {
  // Skeleton tracks the (possibly overridden) issueId, mirroring production where
  // registry.ts builds it from the issue's own id (buildClaimEvent(it.issueId)).
  const issueId = over.issueId ?? "a".repeat(64);
  return {
    issueId,
    subject: "Fix a thing",
    complexity: "M",
    reasons: [],
    claim: null,
    repo: "ngit",
    relays: ["wss://relay.one"], cloneUrl: "https://x.example/r.git",
    claimSkeleton: { kind: 31621, created_at: 0,
      tags: [["d", issueId], ["e", issueId, "", "root"], ["expiration", "259200"], ["status", "claimed"]],
      content: "" },
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

describe("renderWorklistHtml — unreachable repos", () => {
  const ghost: UnreachableRepo = {
    ref: { owner: "1".repeat(64), d: "ghost", name: "ghost" },
    error: "no 30617 for <ghost> on wss://relay.down",
  };

  it("renders a visible banner naming each repo that couldn't be reached", () => {
    const html = renderWorklistHtml([item()], [ghost]);
    expect(html).toMatch(/couldn.?t be reached/i);
    expect(html).toContain("ghost");
    expect(html).toContain("wss://relay.down"); // the failure reason is shown
  });

  it("ESCAPES the untrusted error message (no HTML injection)", () => {
    const html = renderWorklistHtml([item()], [ghost]);
    expect(html).toContain("no 30617 for &lt;ghost&gt;");
    expect(html).not.toContain("no 30617 for <ghost>");
  });

  it("surfaces unreachable repos even when no issues resolved", () => {
    const html = renderWorklistHtml([], [ghost]);
    expect(html).toMatch(/couldn.?t be reached/i);
    expect(html).toContain("ghost");
  });

  it("renders no unreachable banner when every repo resolved", () => {
    const html = renderWorklistHtml([item()]);
    expect(html).not.toMatch(/couldn.?t be reached/i);
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

describe("renderWorklistHtml — WNJ signer", () => {
  it("includes the WNJ signer script (pinned + SRI) and the claim handler", () => {
    const html = renderWorklistHtml([item()]);
    // `defer` is REQUIRED: without it the script runs during <head> parse, before
    // <body> exists, and WNJ's appendChild crashes ("document.body is null").
    expect(html).toMatch(/<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/window\.nostr\.js@\d+\.\d+\.\d+\/dist\/window\.nostr\.min\.js/);
    expect(html).toContain('integrity="sha384-');
    expect(html).toContain("window.nostr.signEvent");
  });
});

describe("renderWorklistHtml — claim controls", () => {
  it("available row with relays gets a Claim button + data-* (skeleton parity with buildClaimEvent)", () => {
    const id = "d".repeat(64);
    const html = renderWorklistHtml([item({ issueId: id })]);
    expect(html).toMatch(/class="claim-btn"[^>]*data-action="claim"/);
    expect(html).toContain(`data-issue-id="${id}"`);
    expect(html).toContain(`data-relays="wss://relay.one"`);
    const want = buildClaimEvent(id, { now: 0 }).tags.filter((t) => t[0] === "d" || t[0] === "e" || t[0] === "status");
    for (const t of want) expect(html).toContain(escapeHtml(JSON.stringify(t)));
  });

  it("claimed row shows the holder label + data-holder; its claim button is present but hidden", () => {
    const html = renderWorklistHtml([item({ claim: { holder: "f".repeat(64), expiresAt: 2e9, contended: false } })]);
    expect(html).toMatch(/claimed · ffffffff/);
    expect(html).toContain(`data-holder="${"f".repeat(64)}"`);
    expect(html).toMatch(/class="claim-btn"[^>]*hidden/);
  });

  it("no-relays repo renders no claim control", () => {
    const html = renderWorklistHtml([item({ relays: [], claimSkeleton: null })]);
    // The handler script always contains ".claim-btn" as a selector; check the row tbody only.
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody).not.toMatch(/claim-btn/);
  });

  it("non-hex id renders no claim control", () => {
    const html = renderWorklistHtml([item({ issueId: "not-hex", claimSkeleton: null })]);
    // The handler script always contains ".claim-btn" as a selector; check the row tbody only.
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody).not.toMatch(/claim-btn/);
  });

  it("clone: https → href, nostr → text, javascript → dropped", () => {
    expect(renderWorklistHtml([item({ cloneUrl: "https://ok.example/r.git" })])).toMatch(/href="https:\/\/ok\.example\/r\.git"/);
    expect(renderWorklistHtml([item({ cloneUrl: "nostr://npub1/r" })])).toContain("git clone nostr://npub1/r");
    expect(renderWorklistHtml([item({ cloneUrl: "javascript:alert(1)" })])).not.toMatch(/javascript:alert/);
  });

  it("</script> in a subject cannot break out (XSS via skeleton/text context)", () => {
    const html = renderWorklistHtml([item({ subject: `</script><img src=x onerror=alert(1)>` })]);
    expect(html).not.toContain(`</script><img`);
    expect(html).toContain("&lt;/script&gt;&lt;img");
  });
});
