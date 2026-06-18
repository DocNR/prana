import { describe, it, expect } from "vitest";
import { renderWorklistHtml, escapeHtml, claimRelays, safeClone, gitworkshopRepoUrl, gitworkshopIssueUrl } from "../src/webui";
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
    owner: "1".repeat(64),
    d: "ngit",
    relays: ["wss://relay.one"], cloneUrl: "https://x.example/r.git",
    claimSkeleton: { kind: 31621, created_at: 0,
      tags: [["d", issueId], ["e", issueId, "", "root"], ["expiration", "259200"], ["status", "claimed"]],
      content: "" },
    ...over,
  };
}

describe("escapeHtml", () => {
  it("escapes HTML metacharacters", () => {
    expect(escapeHtml(`<b>"x"&'</b>`)).toBe("&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;");
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

describe("renderWorklistHtml — gitworkshop links + copy-id (Task 3)", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";

  it("links the repo name and the subject to gitworkshop.dev", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: "prana", repo: "prana", issueId: "a".repeat(64), relays: ["wss://relay.ngit.dev"] })]);
    expect(html).toMatch(/href="https:\/\/gitworkshop\.dev\/npub1[0-9a-z]+\/relay\.ngit\.dev\/prana"/); // repo link
    expect(html).toMatch(/href="https:\/\/gitworkshop\.dev\/npub1[0-9a-z]+\/relay\.ngit\.dev\/prana\/issues\/nevent1[0-9a-z]+"/); // issue link
    expect(html).not.toContain("njump.me"); // njump dropped
  });

  it("renders a copy-id button with an aria-label", () => {
    const html = renderWorklistHtml([item()]);
    expect(html).toMatch(/class="copy-id"[^>]*aria-label="Copy full issue id"/);
  });

  it("ADVERSARIAL: never emits a non-gitworkshop href from row data (no javascript:, no break-out)", () => {
    const html = renderWorklistHtml([item({ owner: OWNER, d: 'a"/<x>', repo: 'r"<x>', subject: `</a><img src=x onerror=alert(1)>`, relays: ["wss://relay.ngit.dev"] })]);
    const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody).not.toMatch(/href="javascript:/i);
    for (const m of tbody.matchAll(/href="([^"]*)"/g)) {
      expect(m[1].startsWith("https://gitworkshop.dev/") || m[1].startsWith("https://x.example/")).toBe(true); // gitworkshop or the clone url
    }
    expect(tbody).toContain("&lt;img"); // the hostile subject is escaped as text
  });

  it("falls back to plain text (no link) when relays are missing or id is non-hex", () => {
    const noRelays = renderWorklistHtml([item({ relays: [], claimSkeleton: null })]);
    const tbody1 = noRelays.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody1).not.toContain("gitworkshop.dev");
    const badId = renderWorklistHtml([item({ issueId: "not-hex", claimSkeleton: null })]);
    const tbody2 = badId.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
    expect(tbody2).not.toMatch(/\/issues\/nevent/);
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

describe("gitworkshop URL builders", () => {
  const OWNER = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";
  const NPUB = "npub1xy54p83r6wnpyhs52xjeztd7qyyeu9ghymz8v66yu8kt3jzx75rqhf3urc";

  it("builds the exact verified prana repo + issue URLs", () => {
    const repo = gitworkshopRepoUrl(OWNER, "prana", ["wss://relay.ngit.dev"]);
    expect(repo).toBe(`https://gitworkshop.dev/${NPUB}/relay.ngit.dev/prana`);
    const issue = gitworkshopIssueUrl(repo, "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf", ["wss://relay.ngit.dev"]);
    expect(issue).toBe(`https://gitworkshop.dev/${NPUB}/relay.ngit.dev/prana/issues/nevent1qy28wumn8ghj7un9d3shjtnwva5hgtnyv4mqqg9vy47mdxf447s4rw50r98v8aecgk65xtjddwddrz3r6wxjvqlleuca4xlq`);
  });

  it("ADVERSARIAL: returns null on a non-hex owner, empty relays, or hostile relay", () => {
    expect(gitworkshopRepoUrl("not-hex", "prana", ["wss://relay.one"])).toBeNull();
    expect(gitworkshopRepoUrl(OWNER, "prana", [])).toBeNull();
    expect(gitworkshopRepoUrl(OWNER, "prana", ["javascript:alert(1)"])).toBeNull(); // host === ""
    expect(gitworkshopRepoUrl(OWNER, "prana", ["not a url"])).toBeNull(); // new URL throws
  });

  it("ADVERSARIAL: a hostile d is percent-encoded and never breaks the URL", () => {
    const url = gitworkshopRepoUrl(OWNER, 'a/../b"<x>', ["wss://relay.one"])!;
    expect(url.startsWith("https://gitworkshop.dev/")).toBe(true);
    expect(url).not.toContain('"');
    expect(url).not.toContain("<");
    expect(url.endsWith("/a%2F..%2Fb%22%3Cx%3E")).toBe(true);
  });

  it("ADVERSARIAL: issue URL is null for a null repo or a non-hex id", () => {
    expect(gitworkshopIssueUrl(null, "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf", ["wss://relay.one"])).toBeNull();
    expect(gitworkshopIssueUrl("https://gitworkshop.dev/x/y/z", "not-hex", ["wss://relay.one"])).toBeNull();
  });

  it("ADVERSARIAL: rejects a wrong-length hex owner (no dead npub link)", () => {
    expect(gitworkshopRepoUrl("aa", "prana", ["wss://relay.ngit.dev"])).toBeNull();
    expect(gitworkshopRepoUrl("ab".repeat(33), "prana", ["wss://relay.ngit.dev"])).toBeNull();
  });

  it("ADVERSARIAL: rejects a non-wss repo relay (consistency with claimRelays)", () => {
    const OWNER2 = "3129509e23d3a6125e1451a5912dbe01099e151726c4766b44e1ecb8c846f506";
    expect(gitworkshopRepoUrl(OWNER2, "prana", ["https://relay.ngit.dev"])).toBeNull();
    expect(gitworkshopRepoUrl(OWNER2, "prana", ["http://relay.ngit.dev"])).toBeNull();
  });

  it("issue URL builds with no relay hint when the relay isn't wss (relay-less nevent)", () => {
    const u = gitworkshopIssueUrl("https://gitworkshop.dev/x/y/z", "ac257db69935afa151ba8f194ec3f73845b5432e4d6b9ad18a23d38d2603ffcf", ["http://nope"]);
    expect(u).toMatch(/\/issues\/nevent1[0-9a-z]+$/);
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
