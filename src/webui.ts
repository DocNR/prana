import { nip19 } from "nostr-tools";
import { MultiRepoItem, UnreachableRepo } from "./registry";
import { DEFAULT_TTL_SECONDS } from "./claimEvent";

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


const GITWORKSHOP = "https://gitworkshop.dev";

/** The shared `<npub>/<relay-host>/<d>` coordinate path, or null if unbuildable.
 *  owner must be 64-hex; relays[0] must be a wss: URL. Host is hostname-encoded
 *  (+ literal port); d is percent-encoded. No untrusted string reaches the result
 *  un-encoded — callers prefix a fixed scheme. */
function repoCoordPath(owner: string, d: string, relays: string[]): string | null {
  if (!/^[0-9a-f]{64}$/i.test(owner)) return null; // a wrong-length pubkey still npub-encodes → reject it, no dead link
  if (!relays.length) return null;
  let host: string;
  try {
    const u = new URL(relays[0]);
    if (u.protocol !== "wss:") return null; // enforce wss: (consistent with claimRelays); blocks http:/javascript:/etc.
    host = encodeURIComponent(u.hostname) + (u.port ? `:${u.port}` : "");
  } catch { return null; }
  let npub: string;
  try { npub = nip19.npubEncode(owner); } catch { return null; }
  return `${npub}/${host}/${encodeURIComponent(d)}`;
}

/** gitworkshop.dev repo page, or null. Format (verified live):
 *  https://gitworkshop.dev/<npub>/<relay-host>/<d>. */
export function gitworkshopRepoUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p ? `${GITWORKSHOP}/${p}` : null;
}

/** ngit-native clone URL: `git clone <this>` wires up the nostr remote (needs ngit),
 *  so a PR lands back on nostr where PRana's worklist/claims live. Same coordinate as
 *  the gitworkshop link / the maintainer's own push remote. null if unbuildable. */
export function ngitCloneUrl(owner: string, d: string, relays: string[]): string | null {
  const p = repoCoordPath(owner, d, relays);
  return p ? `nostr://${p}` : null;
}

/** gitworkshop.dev issue page, or null. Format: <repoUrl>/issues/<nevent>, where the
 *  nevent carries the issue's first relay hint (matches gitworkshop's own encoding). */
export function gitworkshopIssueUrl(repoUrl: string | null, issueId: string, relays: string[]): string | null {
  if (!repoUrl) return null;
  // only put a wss: relay hint into the nevent (matches claimRelays / gitworkshop's own encoding)
  const hint = relays.slice(0, 1).filter((r) => {
    try { return new URL(r).protocol === "wss:"; } catch { return false; }
  });
  let nevent: string;
  try { nevent = nip19.neventEncode({ id: issueId, relays: hint }); } catch { return null; }
  return `${repoUrl}/issues/${nevent}`;
}

const isAvailable = (it: MultiRepoItem): boolean => !it.claim || it.claim.holder === null;

function claimText(it: MultiRepoItem): string {
  if (isAvailable(it)) return "available";
  if (it.claim!.contended) return "contended";
  return `claimed · ${it.claim!.holder!.slice(0, 8)}`;
}

function controlCell(it: MultiRepoItem): string {
  const relays = claimRelays(it.relays);
  const claimable = it.claimSkeleton !== null && relays.length > 0;
  if (!claimable) return `<td class="act"></td>`;
  const hidden = isAvailable(it) ? "" : " hidden";
  return `<td class="act"><button class="claim-btn" data-action="claim"${hidden}>Claim</button></td>`;
}

/** Short label for a mirror host: the registrable name (github.com → "github",
 *  codeberg.org → "codeberg"); falls back to the full hostname, then "git". */
function mirrorLabel(url: string): string {
  try {
    const host = new URL(url).hostname;
    const parts = host.split(".");
    return parts.length >= 2 ? parts[parts.length - 2] : host;
  } catch { return "git"; }
}

/** A click-to-copy clone chip. `command` is the full `git clone …` line; it is the
 *  copy payload (data-copy), the hover tooltip (title), and never an href. */
function cloneChip(label: string, command: string, extraClass = ""): string {
  const cls = extraClass ? `clone-chip ${extraClass}` : "clone-chip";
  return `<button class="${cls}" type="button" data-copy="${escapeHtml(command)}" aria-label="Copy ${escapeHtml(label)} clone command" title="${escapeHtml(command)}"><span class="cc-ic" aria-hidden="true">⧉</span>${escapeHtml(label)}</button>`;
}

function cloneCell(it: MultiRepoItem): string {
  const chips: string[] = [];
  const ngit = ngitCloneUrl(it.owner, it.d, it.relays);
  if (ngit) chips.push(cloneChip("ngit", `git clone ${ngit}`, "ng"));
  if (it.cloneUrl) {
    const c = safeClone(it.cloneUrl);
    if (c && c.kind === "href") chips.push(cloneChip(mirrorLabel(c.url), `git clone ${c.url}`));
  }
  return `<td class="clone" data-label="clone">${chips.join("")}</td>`;
}

function row(it: MultiRepoItem): string {
  const repoUrl = gitworkshopRepoUrl(it.owner, it.d, it.relays);
  const issueUrl = gitworkshopIssueUrl(repoUrl, it.issueId, it.relays);
  const repoLabel = escapeHtml(it.repo);
  const repoCell = repoUrl
    ? `<a href="${escapeHtml(repoUrl)}" target="_blank" rel="noopener">${repoLabel}</a>`
    : repoLabel;
  const subj = escapeHtml(it.subject);
  const subjectCell = issueUrl
    ? `<a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener">${subj}</a>`
    : subj;
  const avail = isAvailable(it);
  const holder = it.claim?.holder ?? "";
  const relays = claimRelays(it.relays);
  const skeletonAttr = it.claimSkeleton ? ` data-skeleton="${escapeHtml(JSON.stringify(it.claimSkeleton))}"` : "";
  return [
    `<tr data-cx="${it.complexity}" data-repo="${escapeHtml(it.repo)}" data-avail="${avail}"`,
    ` data-issue-id="${escapeHtml(it.issueId)}" data-relays="${escapeHtml(relays.join(","))}"`,
    ` data-holder="${escapeHtml(holder)}"${skeletonAttr}>`,
    `<td class="repo" data-label="repo">${repoCell}</td>`,
    `<td data-label="size"><span class="badge cx-${it.complexity}">${it.complexity}</span></td>`,
    `<td data-label="claim"><span class="claim ${avail ? "open" : "taken"}">${escapeHtml(claimText(it))}</span></td>`,
    `<td class="subject" data-label="subject">${subjectCell}</td>`,
    `<td class="id" data-label="id"><span class="idtext">${escapeHtml(it.issueId.slice(0, 8))}</span><button class="copy-id" type="button" aria-label="Copy full issue id" title="Copy full issue id">⧉</button></td>`,
    controlCell(it),
    cloneCell(it),
    `</tr>`,
  ].join("");
}

/**
 * A visible banner for repos that couldn't be reached this run (relays persistently
 * down), so a dropped repo is surfaced instead of silently missing. Returns "" when
 * every repo resolved. SECURITY: the repo label and error message are interpolated
 * from registry/relay-side strings — escape both, same as every other cell.
 */
function unreachableBanner(unreachable: UnreachableRepo[]): string {
  if (unreachable.length === 0) return "";
  const lis = unreachable
    .map((u) => `<li><span class="repo">${escapeHtml(u.ref.name ?? u.ref.d)}</span> — ${escapeHtml(u.error)}</li>`)
    .join("");
  return `<div class="unreachable" role="alert"><strong>${unreachable.length} repo(s) couldn't be reached this run (relays down — not omitted)</strong><ul>${lis}</ul></div>`;
}

export function renderWorklistHtml(items: MultiRepoItem[], unreachable: UnreachableRepo[] = []): string {
  const repos = [...new Set(items.map((i) => i.repo))].sort();
  const available = items.filter(isAvailable).length;
  const counts = items.reduce<Record<string, number>>((a, i) => ((a[i.complexity] = (a[i.complexity] ?? 0) + 1), a), {});
  const repoOptions = ['<option value="">all repos</option>', ...repos.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`)].join("");
  const body = items.length ? items.map(row).join("\n") : `<tr><td colspan="7" class="empty">no open issues across the registry</td></tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>PRana 🐟 — worklist</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0 auto; padding: 1.5rem; max-width: 1200px; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .sub { opacity: .7; margin: 0 0 1rem; }
  .controls { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-bottom: 1rem; }
  button.f { border: 1px solid #8884; background: transparent; border-radius: 999px; padding: .25rem .7rem; cursor: pointer; font: inherit; }
  button.f.on { background: #4a90d9; color: #fff; border-color: #4a90d9; }
  select, label.av { font: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #8883; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  thead th { position: sticky; top: 0; background: Canvas; }
  .count { opacity: .7; font-size: .85rem; margin-left: auto; }
  th button.sort { font: inherit; background: none; border: 0; padding: 0; margin: 0; cursor: pointer; color: inherit; text-transform: inherit; letter-spacing: inherit; display: inline-flex; align-items: center; gap: .25rem; }
  th button.sort .arr::after { content: ""; font-size: .7em; opacity: .7; }
  th button.sort[aria-sort="ascending"] .arr::after { content: "▲"; }
  th button.sort[aria-sort="descending"] .arr::after { content: "▼"; }
  .badge { display: inline-block; min-width: 1.2rem; text-align: center; border-radius: 4px; padding: 0 .35rem; font-weight: 600; }
  .cx-S { background: #2e7d32; color: #fff; } .cx-M { background: #b9770e; color: #fff; } .cx-L { background: #b23b3b; color: #fff; }
  .claim.open { color: #2e7d32; } .claim.taken { opacity: .6; }
  .repo { font-variant: small-caps; opacity: .85; } .id { font-family: ui-monospace, monospace; opacity: .6; }
  .subject a { color: inherit; } .empty { opacity: .6; padding: 1.5rem; text-align: center; }
  .unreachable { border: 1px solid #b23b3b; background: #b23b3b1a; border-radius: 6px; padding: .6rem .9rem; margin: 0 0 1rem; }
  .unreachable strong { color: #b23b3b; } .unreachable ul { margin: .35rem 0 0; padding-left: 1.2rem; } .unreachable li { opacity: .85; }
  .clone-chip { font: inherit; font-size: .8rem; display: inline-flex; align-items: center; gap: 3px; border: 0.5px solid #8884; border-radius: 6px; padding: 1px 7px; margin: 0 3px 0 0; cursor: pointer; background: transparent; color: inherit; }
  .clone-chip:hover { border-color: #8888; }
  .clone-chip .cc-ic { opacity: .6; }
  .clone-chip.ng { border-color: #1d9e7577; color: #1d9e75; }
  @media (max-width: 640px) {
    body { padding: .75rem; }
    thead { display: none; }
    table, tbody, tr, td { display: block; width: 100%; }
    tr { border: 1px solid #8884; border-radius: 8px; margin-bottom: .6rem; padding: .3rem .2rem; }
    td { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; border: none; padding: .25rem .5rem; }
    td::before { content: attr(data-label); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; opacity: .55; }
    td.subject { flex-direction: column; align-items: flex-start; gap: .1rem; }
    td:empty { display: none; }
  }
</style>
<script>window.wnjParams = { position: 'bottom', accent: 'green', startHidden: true, appMetadata: { name: 'PRana' } };</script>
<script defer src="https://cdn.jsdelivr.net/npm/window.nostr.js@0.7.1/dist/window.nostr.min.js" integrity="sha384-NXQunbmQGIyNl1fc21WUnd+bnTzHy9PcJxhzI8MeUG6kJsaWL9Ok72zo9RCZOKd7" crossorigin="anonymous"></script>
</head>
<body>
  <h1>PRana 🐟 — worklist</h1>
  <p class="sub">${items.length} open across ${repos.length} repo(s) · ${available} available · S:${counts.S ?? 0} M:${counts.M ?? 0} L:${counts.L ?? 0}</p>
  ${unreachableBanner(unreachable)}
  <div class="controls">
    <button class="f on" data-cx="">all</button>
    <button class="f" data-cx="S">S</button>
    <button class="f" data-cx="M">M</button>
    <button class="f" data-cx="L">L</button>
    <select id="repo">${repoOptions}</select>
    <label class="av"><input type="checkbox" id="avail"/> available only</label>
    <span class="count" id="count">showing ${items.length} of ${items.length}</span>
  </div>
  <table>
    <thead><tr>
      <th><button class="sort" type="button" data-sort="repo" aria-sort="none">repo<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="size" aria-sort="none">size<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="claim" aria-sort="none">claim<span class="arr" aria-hidden="true"></span></button></th>
      <th><button class="sort" type="button" data-sort="subject" aria-sort="none">subject<span class="arr" aria-hidden="true"></span></button></th>
      <th>id</th><th></th><th></th>
    </tr></thead>
    <tbody id="rows">
${body}
    </tbody>
  </table>
<script>
  const state = { cx: "", repo: "", avail: false };
  const rows = [...document.querySelectorAll("#rows tr[data-cx]")];
  const countEl = document.getElementById("count");
  function updateCount() {
    const visible = rows.filter((r) => r.style.display !== "none").length;
    if (countEl) countEl.textContent = \`showing \${visible} of \${rows.length}\`;
  }
  const tbody = document.getElementById("rows");
  const CX = { S: 0, M: 1, L: 2 };
  const sortState = { key: null, dir: 1 };
  function sortKey(tr, key) {
    if (key === "size") return CX[tr.dataset.cx] ?? 99;
    if (key === "claim") return tr.dataset.avail === "true" ? 0 : 1; // available first
    if (key === "subject") return (tr.querySelector(".subject")?.textContent || "").toLowerCase();
    return (tr.dataset.repo || "").toLowerCase(); // "repo"
  }
  function sortBy(key) {
    sortState.dir = sortState.key === key ? -sortState.dir : 1;
    sortState.key = key;
    const sorted = [...tbody.querySelectorAll("tr[data-cx]")].sort((a, b) => {
      const ka = sortKey(a, key), kb = sortKey(b, key);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * sortState.dir;
    });
    for (const r of sorted) tbody.appendChild(r);
    document.querySelectorAll("button.sort").forEach((b) =>
      b.setAttribute("aria-sort", b.dataset.sort === key ? (sortState.dir === 1 ? "ascending" : "descending") : "none"));
  }
  document.querySelectorAll("button.sort").forEach((b) => b.addEventListener("click", () => sortBy(b.dataset.sort)));
  function apply() {
    for (const r of rows) {
      const okCx = !state.cx || r.dataset.cx === state.cx;
      const okRepo = !state.repo || r.dataset.repo === state.repo;
      const okAvail = !state.avail || r.dataset.avail === "true";
      r.style.display = okCx && okRepo && okAvail ? "" : "none";
    }
    updateCount();
  }
  document.querySelectorAll("button.f").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("button.f").forEach((x) => x.classList.remove("on"));
    b.classList.add("on"); state.cx = b.dataset.cx; apply();
  }));
  document.getElementById("repo").addEventListener("change", (e) => { state.repo = e.target.value; apply(); });
  document.getElementById("avail").addEventListener("change", (e) => { state.avail = e.target.checked; apply(); });
  const TTL = ${DEFAULT_TTL_SECONDS};
  let pubkey = null;
  function revealReleases() {
    if (!pubkey) return;
    for (const tr of document.querySelectorAll("#rows tr[data-holder]")) {
      if (tr.dataset.holder && tr.dataset.holder.toLowerCase() === pubkey) {
        const b = tr.querySelector(".claim-btn");
        if (b) { b.textContent = "Release"; b.dataset.action = "release"; b.hidden = false; }
      }
    }
  }
  async function ensurePubkey() {
    if (pubkey) return pubkey;
    if (!window.nostr) throw new Error("no signer available");
    pubkey = (await window.nostr.getPublicKey()).toLowerCase();
    revealReleases();
    return pubkey;
  }
  function publish(relays, event) {
    return new Promise((resolve) => {
      let pending = relays.length, ok = false;
      if (!pending) return resolve(false);
      for (const url of relays) {
        let ws; try { ws = new WebSocket(url); } catch (e) { if (--pending === 0) resolve(ok); continue; }
        const done = () => { try { ws.close(); } catch (e) {} if (--pending === 0) resolve(ok); };
        const timer = setTimeout(done, 5000);
        ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
        ws.onmessage = (m) => { try { const d = JSON.parse(m.data);
          if (d[0] === "OK" && d[1] === event.id) { if (d[2] === true) ok = true; clearTimeout(timer); done(); } } catch (e) {} };
        ws.onerror = () => { clearTimeout(timer); done(); };
      }
    });
  }
  async function act(btn) {
    const tr = btn.closest("tr");
    const relays = (tr.dataset.relays || "").split(",").filter(Boolean);
    if (!relays.length || !tr.dataset.skeleton) return;
    const action = btn.dataset.action || "claim";
    const orig = btn.textContent; btn.disabled = true; btn.textContent = "signing…";
    try {
      const pk = await ensurePubkey();
      const sk = JSON.parse(tr.dataset.skeleton);
      const now = Math.floor(Date.now() / 1000);
      const tags = sk.tags.filter((t) => t[0] !== "expiration" && t[0] !== "status")
        .concat([["expiration", String(now + TTL)], ["status", action === "release" ? "released" : "claimed"]]);
      const signed = await window.nostr.signEvent({ kind: sk.kind, created_at: now, tags, content: "" });
      btn.textContent = "publishing…";
      if (!(await publish(relays, signed))) throw new Error("no relay accepted");
      const cell = tr.querySelector(".claim");
      if (action === "release") {
        tr.dataset.holder = ""; tr.dataset.avail = "true";
        if (cell) { cell.textContent = "available"; cell.className = "claim open"; }
        btn.textContent = "Claim"; btn.dataset.action = "claim";
      } else {
        tr.dataset.holder = pk; tr.dataset.avail = "false";
        if (cell) { cell.textContent = "claimed \xB7 " + pk.slice(0, 8); cell.className = "claim taken"; }
        btn.textContent = "Release"; btn.dataset.action = "release";
      }
      btn.disabled = false;
    } catch (e) {
      btn.textContent = orig; btn.disabled = false;
      alert("Failed: " + (e && e.message ? e.message : e));
    }
  }
  document.querySelectorAll(".copy-id").forEach((b) => b.addEventListener("click", () => {
    const id = b.closest("tr").dataset.issueId;
    if (!id || !navigator.clipboard) return;
    navigator.clipboard.writeText(id).then(() => {
      const t = b.textContent; b.textContent = "✓";
      setTimeout(() => { b.textContent = t; }, 1000);
    }).catch(() => {});
  }));
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => {
    const cmd = b.dataset.copy;
    if (!cmd || !navigator.clipboard) return;
    const ic = b.querySelector(".cc-ic") || b;
    navigator.clipboard.writeText(cmd).then(() => {
      const t = ic.textContent; ic.textContent = "✓";
      setTimeout(() => { ic.textContent = t; }, 1000);
    }).catch(() => {});
  }));
  document.querySelectorAll(".claim-btn").forEach((b) => b.addEventListener("click", () => act(b)));
</script>
</body></html>`;
}
