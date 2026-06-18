import { nip19 } from "nostr-tools";
import { MultiRepoItem } from "./registry";

/**
 * Pure HTML rendering for the worklist web UI (roadmap #5). Kept separate from the
 * server so it is testable with no network. The server (src/server.ts) fetches the
 * cross-project worklist and hands the items here.
 *
 * SECURITY: subjects and repo names come from UNTRUSTED nostr events. Everything
 * interpolated into HTML is escaped (escapeHtml) — a malicious issue subject must
 * not be able to inject script into the directory page.
 */

/** Publish targets, sanitized: parse, keep only `wss:`, dedupe, cap at 8 (spec review #2). */
export function claimRelays(relays: string[]): string[] {
  const out: string[] = [];
  for (const r of relays) {
    let u: URL;
    try { u = new URL(r); } catch { continue; }
    if (u.protocol !== "wss:") continue;
    const href = u.href.replace(/\/$/, ""); // new URL adds a trailing slash; normalize it off
    if (!out.includes(href)) out.push(href);
    if (out.length === 8) break;
  }
  return out;
}

/** A clone URL classified for safe rendering (spec review #5). `new URL().protocol` is the
 *  only robust scheme check — string matching is bypassable. */
export function safeClone(clone: string): { kind: "href" | "text"; url: string } | null {
  let u: URL;
  try { u = new URL(clone); } catch { return null; }
  if (u.protocol === "http:" || u.protocol === "https:") return { kind: "href", url: clone };
  if (u.protocol === "nostr:") return { kind: "text", url: clone };
  return null; // javascript:, data:, vbscript:, … → dropped
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deep-link an issue to njump (renders any nostr event). Falls back to no link
 *  if the id isn't a valid 64-hex event id (e.g. synthetic test ids). */
export function issueLink(issueId: string): string | null {
  try {
    return `https://njump.me/${nip19.noteEncode(issueId)}`;
  } catch {
    return null;
  }
}

const isAvailable = (it: MultiRepoItem): boolean => !it.claim || it.claim.holder === null;

function claimText(it: MultiRepoItem): string {
  if (isAvailable(it)) return "available";
  if (it.claim!.contended) return "contended";
  return `claimed · ${it.claim!.holder!.slice(0, 8)}`;
}

function row(it: MultiRepoItem): string {
  const link = issueLink(it.issueId);
  const subj = escapeHtml(it.subject);
  const subjectCell = link ? `<a href="${link}" target="_blank" rel="noopener">${subj}</a>` : subj;
  const avail = isAvailable(it);
  return [
    `<tr data-cx="${it.complexity}" data-repo="${escapeHtml(it.repo)}" data-avail="${avail}">`,
    `<td class="repo">${escapeHtml(it.repo)}</td>`,
    `<td><span class="badge cx-${it.complexity}">${it.complexity}</span></td>`,
    `<td><span class="claim ${avail ? "open" : "taken"}">${escapeHtml(claimText(it))}</span></td>`,
    `<td class="subject">${subjectCell}</td>`,
    `<td class="id">${escapeHtml(it.issueId.slice(0, 8))}</td>`,
    `</tr>`,
  ].join("");
}

export function renderWorklistHtml(items: MultiRepoItem[]): string {
  const repos = [...new Set(items.map((i) => i.repo))].sort();
  const available = items.filter(isAvailable).length;
  const counts = items.reduce<Record<string, number>>((a, i) => ((a[i.complexity] = (a[i.complexity] ?? 0) + 1), a), {});
  const repoOptions = ['<option value="">all repos</option>', ...repos.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)].join("");
  const body = items.length ? items.map(row).join("\n") : `<tr><td colspan="5" class="empty">no open issues across the registry</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PRana 🐟 — worklist</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 960px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin: 0 0 1rem; }
  .controls { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
  button.f { border: 1px solid #8884; background: transparent; border-radius: 999px; padding: .25rem .7rem; cursor: pointer; font: inherit; }
  button.f.on { background: #4a90d9; color: #fff; border-color: #4a90d9; }
  select, label.av { font: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  .badge { display: inline-block; min-width: 1.2rem; text-align: center; border-radius: 4px; padding: 0 .35rem; font-weight: 600; }
  .cx-S { background: #2e7d32; color: #fff; } .cx-M { background: #b9770e; color: #fff; } .cx-L { background: #b23b3b; color: #fff; }
  .claim.open { color: #2e7d32; } .claim.taken { opacity: .6; }
  .repo { font-variant: small-caps; opacity: .85; } .id { font-family: ui-monospace, monospace; opacity: .6; }
  .subject a { color: inherit; } .empty { opacity: .6; padding: 1.5rem; text-align: center; }
</style></head>
<body>
  <h1>PRana 🐟 — worklist</h1>
  <p class="sub">${items.length} open across ${repos.length} repo(s) · ${available} available · S:${counts.S ?? 0} M:${counts.M ?? 0} L:${counts.L ?? 0}</p>
  <div class="controls">
    <button class="f on" data-cx="">all</button>
    <button class="f" data-cx="S">S</button>
    <button class="f" data-cx="M">M</button>
    <button class="f" data-cx="L">L</button>
    <select id="repo">${repoOptions}</select>
    <label class="av"><input type="checkbox" id="avail"/> available only</label>
  </div>
  <table>
    <thead><tr><th>repo</th><th>size</th><th>claim</th><th>subject</th><th>id</th></tr></thead>
    <tbody id="rows">
${body}
    </tbody>
  </table>
<script>
  const state = { cx: "", repo: "", avail: false };
  const rows = [...document.querySelectorAll("#rows tr[data-cx]")];
  function apply() {
    for (const r of rows) {
      const okCx = !state.cx || r.dataset.cx === state.cx;
      const okRepo = !state.repo || r.dataset.repo === state.repo;
      const okAvail = !state.avail || r.dataset.avail === "true";
      r.style.display = okCx && okRepo && okAvail ? "" : "none";
    }
  }
  document.querySelectorAll("button.f").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("button.f").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); state.cx = b.dataset.cx; apply();
  }));
  document.getElementById("repo").addEventListener("change", (e) => { state.repo = e.target.value; apply(); });
  document.getElementById("avail").addEventListener("change", (e) => { state.avail = e.target.checked; apply(); });
</script>
</body></html>`;
}
