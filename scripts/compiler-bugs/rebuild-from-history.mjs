// For a contract on mainnet whose compiler input was never recorded:
// rebuild the input from the repository's own sources at a given commit and
// a recorded input of the same period (deployments/<network>/solcInputs),
// which holds the literal dependency sources of that time. Compile it with
// the compiler of that time and compare with the chain.
//
// The JOB matters, not only the sources. With viaIR under solc 0.8.20 the
// bytecode of a contract depends on which other files were compiled in the
// same job, and Hardhat compiles incrementally: from a warm cache it builds
// only the files whose imports reach a changed file, each with its own
// dependencies. Three job shapes can be rebuilt:
//   (default)        the whole job of the base input, sources taken at the commit
//   ROOTS=a.sol,...  the import closure of these files alone
//   CHANGED=a.sol,.. what Hardhat builds from a warm cache when these files
//                    changed (optional SKIP=<regex> leaves roots out)
//
//   node scripts/compiler-bugs/rebuild-from-history.mjs <base input json> <commit> <address> [contract name]
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

import { compile, errorsOf, getCode, nativeSolc, repo, withoutIpfsHash, work } from "./env.mjs";

const VERSION = "0.8.20";
const [baseArg, commit, address, name = "TransferEOALegacy"] = process.argv.slice(2);
if (!address) throw new Error("usage: rebuild-from-history.mjs <base input json> <commit> <address> [contract name]");
const exe = nativeSolc(VERSION);
const base = JSON.parse(readFileSync(resolve(baseArg), "utf8"));
// The recorded inputs were written on a checkout with CRLF line ends; git holds LF.
// Line ends do not change the code, only the metadata hash, so they are matched to the base input.
const crlf = Object.entries(base.sources).some(([key, s]) => key.startsWith("contracts/") && s.content.includes("\r\n"));
const atCommit = (path) => {
  try {
    const text = execFileSync("git", ["-C", repo, "show", `${commit}:${path}`], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  } catch {
    return null;
  }
};
const IMPORT = /import\s+(?:[^"';]*?from\s+)?["']([^"']+)["']/g;
const importsOf = (file, text) =>
  [...text.matchAll(IMPORT)].map((m) => (m[1].startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), m[1])) : m[1]));

// Every dependency source any recorded input holds, by source name.
const recorded = new Map();
for (const network of ["mainnet", "sepolia"]) {
  const dir = join(repo, "deployments", network, "solcInputs");
  for (const file of readdirSync(dir)) {
    const input = JSON.parse(readFileSync(join(dir, file), "utf8"));
    for (const [key, source] of Object.entries(input.sources))
      if (!key.startsWith("contracts/") && !recorded.has(key)) recorded.set(key, source.content);
  }
}

const roots = (process.env.ROOTS ?? "").split(",").filter(Boolean);
const changedFiles = (process.env.CHANGED ?? "").split(",").filter(Boolean);
if (changedFiles.length) {
  const all = execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", commit, "--", "contracts"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".sol"));
  const deps = new Map(all.map((file) => [file, importsOf(file, atCommit(file) ?? "").filter((t) => t.startsWith("contracts/"))]));
  const reaches = (file, seen = new Set()) => {
    if (changedFiles.includes(file)) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return (deps.get(file) ?? []).some((d) => reaches(d, seen));
  };
  const skip = new RegExp(process.env.SKIP ?? "^$");
  for (const file of all) if (reaches(file) && !skip.test(file)) roots.push(file);
  console.log(`files whose imports reach ${changedFiles.join(", ")}: ${roots.join(", ")}`);
}

const sources = {};
const changed = [];
const dropped = [];
for (const root of roots) {
  const content = atCommit(root);
  if (content === null) {
    console.log(`no ${root} at ${commit}`);
    process.exit(2);
  }
  sources[root] = { content };
}
for (const [key, source] of roots.length ? [] : Object.entries(base.sources)) {
  if (!key.startsWith("contracts/")) {
    sources[key] = { content: source.content };
    continue;
  }
  const content = atCommit(key);
  if (content === null) {
    dropped.push(key);
    continue;
  }
  if (content !== source.content) changed.push(key);
  sources[key] = { content };
}
// The import closure: what the commit's sources import and the job does not hold yet.
const added = [];
const queue = Object.keys(sources);
while (queue.length) {
  const key = queue.shift();
  for (const target of importsOf(key, sources[key].content)) {
    if (sources[target]) continue;
    const content = target.startsWith("contracts/") ? atCommit(target) : recorded.get(target) ?? null;
    if (content === null) {
      console.log(`MISSING import ${target} (from ${key}): no recorded input holds it`);
      process.exit(2);
    }
    sources[target] = { content };
    added.push(target);
    queue.push(target);
  }
}
console.log(
  roots.length
    ? `commit ${commit}: ${Object.keys(sources).length} sources (${roots.length} roots and their dependencies)`
    : `commit ${commit}: ${Object.keys(sources).length} sources; changed against the base input: ${changed.join(", ") || "none"}; added: ${
        added.join(", ") || "none"
      }; dropped: ${dropped.join(", ") || "none"}`
);

const full = { language: base.language, sources, settings: structuredClone(base.settings) };
const selected = structuredClone(full);
const holders = Object.keys(sources).filter((s) => new RegExp(`contract\\s+${name}\\b`).test(sources[s].content));
selected.settings.outputSelection = Object.fromEntries(
  holders.map((s) => [s, { [name]: ["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] }])
);
const out = await compile(exe, selected);
if (errorsOf(out).length) {
  console.log(`compile errors: ${errorsOf(out).join("\n").slice(0, 1500)}`);
  process.exit(3);
}
const onChain = await getCode(address);
let reproduced = false;
for (const s of holders) {
  const c = out.contracts[s][name];
  let built = c.evm.deployedBytecode.object.toLowerCase();
  let chain = onChain;
  const refs = Object.values(c.evm.deployedBytecode.immutableReferences ?? {}).flat();
  if (built.length === chain.length) {
    for (const { start, length } of refs) {
      const zero = "0".repeat(length * 2);
      built = built.slice(0, start * 2) + zero + built.slice((start + length) * 2);
      chain = chain.slice(0, start * 2) + zero + chain.slice((start + length) * 2);
    }
  }
  const same = built === chain;
  const sameCode = withoutIpfsHash(built) === withoutIpfsHash(chain);
  let firstDiff = -1;
  let differing = 0;
  if (!sameCode) {
    for (let i = 0; i < Math.min(built.length, chain.length); i += 2) {
      if (built.slice(i, i + 2) === chain.slice(i, i + 2)) continue;
      differing += 1;
      if (firstDiff < 0) firstDiff = i / 2;
    }
  }
  console.log(
    `${s}:${name} built ${built.length / 2} bytes, chain ${chain.length / 2} bytes, immutables ${refs.length}: ` +
      (same
        ? "IDENTICAL to the chain"
        : sameCode
        ? "identical apart from the metadata hash"
        : `DIFFERENT (first at byte ${firstDiff}, ${differing} bytes differ in the common length)`)
  );
  if (!sameCode) continue;
  reproduced = true;
  const shape = changedFiles.length
    ? `, warm-cache job after a change of ${changedFiles.join(", ")}`
    : roots.length
    ? `, job of ${roots.join(", ")}`
    : ", whole job";
  writeFileSync(
    join(work, "found-inputs", `${address.toLowerCase()}.json`),
    JSON.stringify({
      compilation: { compilerVersion: `${VERSION}+commit.${exe.match(/commit\.([0-9a-f]{8})/)[1]}`, fullyQualifiedName: `${s}:${name}` },
      stdJsonInput: full,
      match: `sources of commit ${commit}, dependencies of ${relative(repo, resolve(baseArg)).replace(/\\/g, "/")}${shape}${
        same ? "" : " (metadata hash differs)"
      }`,
    })
  );
  console.log(`  kept as ${join(work, "found-inputs", `${address.toLowerCase()}.json`)}`);
}
if (!reproduced) process.exitCode = 1;
