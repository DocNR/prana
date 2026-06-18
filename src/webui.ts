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

/** Deep-link an issue to njump (renders any nostr event). Falls back to no link
 *  if the id isn't a valid 64-hex event id (e.g. synthetic test ids). */
export function issueLink(issueId: string): string | null {
  try {
    return `https://njump.me/${nip19.noteEncode(issueId)}`;
  } catch {
    return null;
  }
}

const GITWORKSHOP = "https://gitworkshop.dev";

/** gitworkshop.dev repo page, or null if it can't be built safely.
 *  Format (verified live): https://gitworkshop.dev/<npub>/<relay-host>/<d>.
 *  Built only from a bech32 npub + new URL().host + an encoded d — no untrusted
 *  string reaches the URL un-encoded, so the result is always a gitworkshop https URL. */
export function gitworkshopRepoUrl(owner: string, d: string, relays: string[]): string | null {
  if (!/^[0-9a-f]{64}$/i.test(owner)) return null; // a wrong-length pubkey still npub-encodes → reject it, no dead link
  if (!relays.length) return null;
  let host: string;
  try {
    const u = new URL(relays[0]);
    if (u.protocol !== "wss:") return null; // enforce wss: (consistent with claimRelays); blocks http:/javascript:/etc.
    host = u.host;
  } catch { return null; }
  let npub: string;
  try { npub = nip19.npubEncode(owner); } catch { return null; }
  return `${GITWORKSHOP}/${npub}/${host}/${encodeURIComponent(d)}`;
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

function cloneCell(it: MultiRepoItem): string {
  if (!it.cloneUrl) return `<td class="clone"></td>`;
  const c = safeClone(it.cloneUrl);
  if (!c) return `<td class="clone"></td>`;
  if (c.kind === "href")
    return `<td class="clone"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">clone</a></td>`;
  return `<td class="clone"><code>git clone ${escapeHtml(c.url)}</code></td>`;
}

function row(it: MultiRepoItem): string {
  const link = issueLink(it.issueId);
  const subj = escapeHtml(it.subject);
  const subjectCell = link ? `<a href="${link}" target="_blank" rel="noopener">${subj}</a>` : subj;
  const avail = isAvailable(it);
  const holder = it.claim?.holder ?? "";
  const relays = claimRelays(it.relays);
  const skeletonAttr = it.claimSkeleton ? ` data-skeleton="${escapeHtml(JSON.stringify(it.claimSkeleton))}"` : "";
  return [
    `<tr data-cx="${it.complexity}" data-repo="${escapeHtml(it.repo)}" data-avail="${avail}"`,
    ` data-issue-id="${escapeHtml(it.issueId)}" data-relays="${escapeHtml(relays.join(","))}"`,
    ` data-holder="${escapeHtml(holder)}"${skeletonAttr}>`,
    `<td class="repo">${escapeHtml(it.repo)}</td>`,
    `<td><span class="badge cx-${it.complexity}">${it.complexity}</span></td>`,
    `<td><span class="claim ${avail ? "open" : "taken"}">${escapeHtml(claimText(it))}</span></td>`,
    `<td class="subject">${subjectCell}</td>`,
    `<td class="id">${escapeHtml(it.issueId.slice(0, 8))}</td>`,
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
  .unreachable { border: 1px solid #b23b3b; background: #b23b3b1a; border-radius: 6px; padding: .6rem .9rem; margin: 0 0 1rem; }
  .unreachable strong { color: #b23b3b; } .unreachable ul { margin: .35rem 0 0; padding-left: 1.2rem; } .unreachable li { opacity: .85; }
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
  </div>
  <table>
    <thead><tr><th>repo</th><th>size</th><th>claim</th><th>subject</th><th>id</th><th></th><th></th></tr></thead>
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
  document.querySelectorAll(".claim-btn").forEach((b) => b.addEventListener("click", () => act(b)));
</script>
</body></html>`;
}
