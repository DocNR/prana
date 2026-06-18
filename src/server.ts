import { createServer } from "node:http";
import { SimplePool } from "nostr-tools";
import { loadRegistry, fetchRegistryInputs, buildMultiRepoWorklist } from "./registry";
import { poolQuery } from "./fetch";
import { renderWorklistHtml } from "./webui";

/**
 * Minimal web server for the worklist directory (roadmap #5). No framework — it
 * fetches the cross-project worklist over the curated registry, caches it briefly
 * (so a browser refresh doesn't re-hammer relays), and serves the rendered page.
 *
 *   npm run serve [registry.json] [fallbackRelay...]
 */

const PORT = Number(process.env.PORT ?? 8787);
const registryPath = process.argv[2] ?? "registry.json";
const fallbackRelays = process.argv.slice(3);
const TTL_MS = 60_000;

let cache: { at: number; html: string } | null = null;

async function buildHtml(): Promise<string> {
  const refs = loadRegistry(registryPath);
  const pool = new SimplePool();
  try {
    const inputs = await fetchRegistryInputs(refs, fallbackRelays, poolQuery(pool));
    return renderWorklistHtml(await buildMultiRepoWorklist(inputs));
  } finally {
    pool.destroy(); // one warm pool per build; close it once
  }
}

const server = createServer(async (req, res) => {
  if (req.url !== "/") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      cache = { at: Date.now(), html: await buildHtml() };
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(cache.html);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e instanceof Error ? e.message : e));
  }
});

server.listen(PORT, () =>
  console.log(`PRana worklist on http://localhost:${PORT}  (registry: ${registryPath})`),
);
