// Shared by the scripts of this folder (docs/security/compiler-known-bugs.md):
// where the repository, the compilers and the work files are, and the few
// helpers every script needs. Read-only towards the chain; no key is read.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const require = createRequire(join(repo, "package.json"));
require("dotenv").config({ path: join(repo, ".env") });

/**
 * Work folder, outside the repository: downloaded compilers (`solc/`),
 * inputs found for contracts no verifier holds (`found-inputs/`) and the
 * outputs of the longer runs. Set COMPILER_BUGS_DIR to choose another.
 */
export const work = process.env.COMPILER_BUGS_DIR ?? join(tmpdir(), "compiler-bugs");
mkdirSync(join(work, "solc"), { recursive: true });
mkdirSync(join(work, "found-inputs"), { recursive: true });

/** Hardhat's compiler cache, per platform folder. */
function hardhatCompilerDirs() {
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "hardhat-nodejs", "Cache", "compilers-v2"),
    join(homedir(), "Library", "Caches", "hardhat-nodejs", "compilers-v2"),
    join(homedir(), ".cache", "hardhat-nodejs", "compilers-v2"),
  ].filter((root) => root && existsSync(root));
  return roots.flatMap((root) =>
    readdirSync(root)
      .map((platform) => join(root, platform))
      .filter((dir) => statSync(dir).isDirectory())
  );
}

/**
 * A native solc release by version ("0.8.35"), from Hardhat's cache (the
 * compilers the repository itself builds with) or from the work folder
 * (get-compilers.mjs, which checks each download against the published hashes).
 */
export function nativeSolc(version) {
  for (const dir of [...hardhatCompilerDirs(), join(work, "solc")]) {
    const hit = readdirSync(dir).find(
      (f) => f.startsWith("solc-") && f.includes(`v${version}+commit.`) && !f.includes("nightly") && /(\.exe|\+commit\.[0-9a-f]{8})$/.test(f)
    );
    if (hit) return join(dir, hit);
  }
  throw new Error(
    `solc ${version} not found: run "npx hardhat compile" (pinned versions) or "node scripts/compiler-bugs/get-compilers.mjs ${version}"`
  );
}

/** The compiler team's two nightly builds around the 0.8.38 optimizer fix (get-compilers.mjs nightly). */
export const NIGHTLY = {
  before: "soljson-v0.8.38-nightly.2026.10.13+commit.ce5702db.js",
  after: "soljson-v0.8.38-nightly.2026.10.14+commit.8bff1c3a.js",
};
export function nightlySolc(which) {
  const file = join(work, "solc", NIGHTLY[which]);
  if (!existsSync(file)) throw new Error(`${NIGHTLY[which]} not found: node scripts/compiler-bugs/get-compilers.mjs nightly`);
  return require("solc/wrapper")(require(file));
}

/** One standard-JSON compile with a native compiler. */
export const compile = (exe, input) =>
  new Promise((resolve, reject) => {
    const p = spawn(exe, ["--standard-json"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    p.stdout.on("data", (d) => chunks.push(d));
    p.on("error", reject);
    p.on("close", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    p.stdin.end(JSON.stringify(input));
  });
export const errorsOf = (out) => (out.errors ?? []).filter((e) => e.severity === "error").map((e) => e.formattedMessage);

/** The CBOR metadata trailer of a release build: the ipfs hash and the three version bytes. */
export const RELEASE_META = /a264697066735822[0-9a-f]{68}64736f6c6343[0-9a-f]{6}0033/g;
/** The same code with only the ipfs hash set aside (the version bytes stay and must agree). */
export const withoutIpfsHash = (hex) => hex.replace(/a264697066735822[0-9a-f]{68}(?=64736f6c6343)/g, "IPFS");
/**
 * A pre-release build writes its version into the metadata as text (CBOR
 * 0x78 <len> <ascii> 00 <len>), not as three bytes, so its trailer needs its own pattern.
 */
export function nightlyMeta(solc) {
  const hex = Buffer.from(solc.version().replace(/\.Emscripten.*$/, ""), "ascii").toString("hex");
  return new RegExp(`a264697066735822[0-9a-f]{68}64736f6c6378[0-9a-f]{2}${hex}00[0-9a-f]{2}`, "g");
}

/**
 * What three known bugs need in the source text, counted over every source
 * of a compiler input, dependencies included (comments stripped):
 * `require(cond, Err({name: value}))` (MisorderedNamedParametersInRequireWithCustomErrors),
 * a `layout at` storage specifier (InheritanceOrderReversalOnStorageEndWarning)
 * and Yul's `verbatim` (VerbatimInvalidDeduplication).
 */
export function sourcePatterns(sources) {
  const text = Object.values(sources).map((s) => (s.content ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/gm, "$1"));
  const count = (re) => text.reduce((n, s) => n + (s.match(re) ?? []).length, 0);
  return {
    namedErrorInRequire: count(/\brequire\s*\([^;]*?,\s*[A-Za-z_][\w.]*\s*\(\s*\{/g),
    layoutAt: count(/\blayout\s+at\b/g),
    verbatim: count(/\bverbatim_\d+i_\d+o\b/g),
  };
}
{
  // The counting must find what it looks for: a planted case of each, and none in a comment.
  const planted = sourcePatterns({
    a: {
      content:
        'contract C layout at 5 { function f(uint x) external { require(x > 1,\n  Bad({b: 1, a: 2})); assembly { let y := verbatim_0i_1o(hex"00") } } }',
    },
    b: {
      content:
        '// require(x, Bad({a: 1})); layout at 1\n/* verbatim_0i_0o */ contract D { function g(uint x) external { require(x > 1, "no"); revert Bad({a: 1}); } }',
    },
  });
  if (planted.namedErrorInRequire !== 1 || planted.layoutAt !== 1 || planted.verbatim !== 1)
    throw new Error(`source patterns broken: ${JSON.stringify(planted)}`);
}

const RPC = { mainnet: "MAINNET_RPC_URL", sepolia: "SEPOLIA_RPC_URL" };
export async function rpc(method, params, network = "mainnet") {
  const url = process.env[RPC[network]];
  if (!url) throw new Error(`${RPC[network]} is not set in .env`);
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).catch(() => null);
    const body = await res?.json().catch(() => null);
    if (body && "result" in body) return body.result;
    // A provider's rate limit or a dropped connection: a few tries, then the provider's own words.
    if (attempt >= 4) throw new Error(`${method}: ${body?.error?.message ?? res?.status ?? "no answer"}`);
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}
/** Runtime code at an address, lower case, without 0x. */
export const getCode = async (address, network = "mainnet") => (await rpc("eth_getCode", [address, "latest"], network)).slice(2).toLowerCase();

/** Every file under a folder. */
export const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/**
 * The deployable contracts of the current build, by build-info id:
 * Map<id, Set<"source:Contract">> (artifacts/, so run "npx hardhat compile" first).
 */
export function currentBuilds() {
  const byBuild = new Map();
  for (const f of walk(join(repo, "artifacts", "contracts")).filter((f) => f.endsWith(".dbg.json"))) {
    const id = JSON.parse(readFileSync(f, "utf8")).buildInfo.split(/[\\/]/).pop().replace(".json", "");
    const artifact = JSON.parse(readFileSync(f.replace(".dbg.json", ".json"), "utf8"));
    if (artifact.deployedBytecode === "0x") continue; // an interface or an abstract contract
    if (!byBuild.has(id)) byBuild.set(id, new Set());
    byBuild.get(id).add(`${artifact.sourceName}:${artifact.contractName}`);
  }
  return byBuild;
}
export const buildInfo = (id) => JSON.parse(readFileSync(join(repo, "artifacts", "build-info", `${id}.json`), "utf8"));

/**
 * The verified compiler input of a contract on mainnet: the one found for
 * it here (work/found-inputs, written by find-input.mjs and
 * rebuild-from-history.mjs) or Sourcify's.
 */
export async function inputOf(address) {
  const local = join(work, "found-inputs", `${address.toLowerCase()}.json`);
  if (existsSync(local)) {
    const record = JSON.parse(readFileSync(local, "utf8"));
    return { ...record, from: `found here: ${record.match}` };
  }
  const res = await fetch(`https://sourcify.dev/server/v2/contract/1/${address}?fields=compilation,stdJsonInput,runtimeMatch`);
  if (!res.ok) throw new Error(`${address}: no input found here and Sourcify answers ${res.status}`);
  const record = await res.json();
  return { ...record, from: `Sourcify (${record.runtimeMatch ?? record.match ?? "match"})` };
}
