import { MAX_TTL_SECONDS } from "./claimFetch";
import { execFileSync } from "node:child_process";
import { SimplePool, nip19 } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { BunkerSigner, parseBunkerInput } from "nostr-tools/nip46";
import { loadRegistry } from "./registry";
import {
  buildClaimEvent,
  parseTtl,
  DEFAULT_TTL_SECONDS,
  type ClaimTemplate,
  type BuildClaimOpts,
} from "./claimEvent";

// Re-export so existing importers (`from "./claim"`) keep working.
export { buildClaimEvent, parseTtl, DEFAULT_TTL_SECONDS };
export type { ClaimTemplate, BuildClaimOpts };

/**
 * The WRITE half of the claim system: build a claim event that the existing claim
 * fold (`resolveClaim`) and ingest gate (`isAdmissibleClaim`) accept, then sign and
 * publish it. PRana could already READ claims; this is how one gets minted.
 *
 * The pure core (`buildClaimEvent`, `parseTtl`) is I/O-free and unit-tested — it
 * trusts nothing and signs nothing. Signing (NIP-46 bunker by default, `--nsec`
 * fallback) and relay publish are the thin edge at the bottom of this file, exercised
 * live rather than in unit tests. This mirrors the resolver/fetch split: the security
 * boundary (a real signature) is applied at the edge, never faked in the core.
 */

// ---------------------------------------------------------------------------
// CLI edge: sign (NIP-46 bunker by default, --nsec fallback) + publish.
// Everything below is I/O and runs only when invoked directly; the pure core
// above is what the tests exercise. The signature — the real security boundary —
// is applied HERE and never faked.
//
//   npm run claim -- <issueId> [--ttl 3d|12h|30m] [--release]
//                              [--bunker <bunker://…> | --nsec <nsec>]
//                              [--relay <wss://…> ...]
// ---------------------------------------------------------------------------

// Fallbacks if neither --relay nor a registry `prana` entry supplies relays.
const DEFAULT_RELAYS = ["wss://relay.ngit.dev", "wss://relay.damus.io", "wss://nos.lol"];
const HEX64 = /^[0-9a-f]{64}$/;

const USAGE =
  "usage: claim <issueId> [--ttl 3d|12h|30m] [--release] [--bunker <url> | --nsec <nsec>] [--relay <url>...]";

interface CliArgs {
  issueId: string;
  ttlSeconds: number;
  release: boolean;
  bunker?: string;
  nsec?: string;
  relays: string[];
}

/** A flag's value, or a clear error if it's missing. */
function value(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} requires a value`);
  return v;
}

export function parseArgs(argv: string[]): CliArgs {
  let issueId: string | undefined;
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  let release = false;
  let bunker: string | undefined;
  let nsec: string | undefined;
  const relays: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--ttl": ttlSeconds = parseTtl(value(argv, ++i, "--ttl")); break;
      case "--release": release = true; break;
      case "--bunker": bunker = value(argv, ++i, "--bunker"); break;
      case "--nsec": nsec = value(argv, ++i, "--nsec"); break;
      case "--relay": relays.push(value(argv, ++i, "--relay")); break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag ${a}\n${USAGE}`);
        if (issueId !== undefined) throw new Error(`unexpected extra argument "${a}"\n${USAGE}`);
        issueId = a;
    }
  }

  if (!issueId) throw new Error(USAGE);
  if (!HEX64.test(issueId)) throw new Error(`issueId must be a 64-char hex event id (got "${issueId}")`);
  if (bunker && nsec) throw new Error("pass only one signer: --bunker or --nsec");
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`--ttl exceeds the 14-day horizon (max ${MAX_TTL_SECONDS}s)`);
  }
  return { issueId, ttlSeconds, release, bunker, nsec, relays };
}

/** Publish relays: explicit --relay wins; else the registry `prana` entry; else defaults. */
function resolveRelays(cliRelays: string[]): string[] {
  if (cliRelays.length) return cliRelays;
  try {
    const prana = loadRegistry("registry.json").find((r) => r.d === "prana");
    if (prana?.relays?.length) return prana.relays;
  } catch {
    // no registry / unreadable: fall through to the hardcoded defaults.
  }
  return DEFAULT_RELAYS;
}

/** Read a single git config value (merged local+global), or undefined if unset. */
function gitConfig(key: string): string | undefined {
  try {
    const v = execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
    return v || undefined;
  } catch {
    return undefined; // git missing / key unset / not a repo
  }
}

/** Decode a 64-char hex secret key to bytes. Used for a stored client/app key — NEVER log it. */
function hexKeyToBytes(hex: string): Uint8Array {
  if (!HEX64.test(hex)) throw new Error("stored bunker app key is not 64-char hex");
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}

/** How to reach a bunker. `appKey` (hex) is an ALREADY-authorized client key (ngit's
 *  stored session); when absent we mint an ephemeral one and the signer must approve afresh. */
interface BunkerSession {
  uri: string;
  appKey?: string;
}

/** ngit persists an authorized bunker login in git config: the bunker pointer
 *  (`nostr.bunker-uri`) plus the already-approved client key (`nostr.bunker-app-key`).
 *  Reusing them lets `claim` sign through the SAME session ngit uses — no re-pairing,
 *  which is what "I'm already logged in" should mean. */
function ngitBunkerSession(): BunkerSession | undefined {
  const uri = gitConfig("nostr.bunker-uri");
  const appKey = gitConfig("nostr.bunker-app-key");
  return uri && appKey ? { uri, appKey } : undefined;
}

/**
 * Sign the template. Order: explicit `--nsec` (local, tests/CI) → explicit `--bunker`
 * (fresh ephemeral pairing) → the ngit-stored bunker session (default when logged in).
 * The signing key always stays in the remote signer for the bunker paths; secrets
 * (nsec, app key) are decoded but NEVER logged.
 */
async function signClaim(template: ClaimTemplate, args: CliArgs) {
  if (args.nsec) {
    const decoded = nip19.decode(args.nsec);
    if (decoded.type !== "nsec") throw new Error("--nsec must be an nsec1… secret key");
    return finalizeEvent(template, decoded.data);
  }

  const session: BunkerSession | undefined = args.bunker ? { uri: args.bunker } : ngitBunkerSession();
  if (!session) {
    throw new Error(
      "no signer: pass --bunker <bunker://…> or --nsec <nsec>, or log in with ngit " +
        "(sets nostr.bunker-uri + nostr.bunker-app-key in git config)",
    );
  }

  const bp = await parseBunkerInput(session.uri);
  if (!bp) throw new Error(`could not parse bunker URL (${session.uri})`);
  // reuse the authorized app key if we have one; otherwise a one-shot ephemeral key.
  const clientKey = session.appKey ? hexKeyToBytes(session.appKey) : generateSecretKey();
  const signer = BunkerSigner.fromBunker(clientKey, bp, {
    onauth: (url) => console.error(`approve in your signer: ${url}`),
  });
  try {
    const how = session.appKey ? "ngit session" : "new pairing";
    console.error(`connecting to bunker ${bp.pubkey.slice(0, 8)}… via ${bp.relays.join(", ")} (${how}; approve in your signer if prompted)`);
    await signer.connect();
    return await signer.signEvent(template);
  } finally {
    await signer.close();
  }
}

/** Publish to every relay; resolve the count that accepted. Throws if none did. */
async function publish(event: Parameters<SimplePool["publish"]>[1], relays: string[]): Promise<number> {
  const pool = new SimplePool();
  try {
    const results = await Promise.allSettled(pool.publish(relays, event));
    results.forEach((res, i) => {
      if (res.status === "fulfilled") console.error(`  ✓ ${relays[i]}`);
      else console.error(`  ✗ ${relays[i]}: ${res.reason instanceof Error ? res.reason.message : res.reason}`);
    });
    const ok = results.filter((r) => r.status === "fulfilled").length;
    if (ok === 0) throw new Error(`no relay accepted the event (${relays.length} tried)`);
    return ok;
  } finally {
    pool.close(relays);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = Math.floor(Date.now() / 1000);
  const template = buildClaimEvent(args.issueId, {
    now,
    ttlSeconds: args.ttlSeconds,
    release: args.release,
  });

  const signed = await signClaim(template, args);
  const relays = resolveRelays(args.relays);

  const verb = args.release ? "release" : "claim";
  console.error(
    `publishing ${verb} for issue ${args.issueId.slice(0, 8)} as ${signed.pubkey.slice(0, 8)} -> ${relays.length} relay(s)`,
  );
  const ok = await publish(signed, relays);

  const expiry = Number(template.tags.find((t) => t[0] === "expiration")![1]);
  console.log("");
  console.log(`${args.release ? "released" : "claimed"} issue ${args.issueId}`);
  console.log(`  event id : ${signed.id}`);
  console.log(`  by       : ${signed.pubkey}`);
  if (!args.release) {
    console.log(`  expires  : ${new Date(expiry * 1000).toISOString()}  (${args.ttlSeconds}s)`);
  }
  console.log(`  relays   : ${ok}/${relays.length} accepted`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
