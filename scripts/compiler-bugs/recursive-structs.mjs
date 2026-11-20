// Recursive structs in every source we ever compiled, for the bug fixed in
// solc 0.8.39 (OverlappingRecursiveStorageStructCopyCorruption, both
// pipelines, every version since 0.4.9): overwriting a recursive struct in
// storage with a struct nested inside it corrupts storage. The bug needs a
// struct that holds a dynamically-sized array of its own type, directly or
// through other structs. No such struct, no such copy.
//
// Read-only, no network, no key. Sources scanned:
//   - the compiler inputs of everything deployed with hardhat-deploy
//     (deployments/<network>/solcInputs/*.json: ours, OpenZeppelin, Safe,
//     Chainlink, Uniswap, the proxies), every version;
//   - the compiler inputs of the current build (artifacts/build-info/*.json,
//     present after `npx hardhat compile`);
//   - the sources inside the artifacts hardhat-deploy ships (the proxies and
//     the ProxyAdmin on the chain are that bytecode);
//   - contracts/ as it is in the working tree, and every version of every
//     Solidity file in the repository's history (git, all refs).
// The check errs on the side of reporting: a struct counts as referring to
// another when the other's name appears anywhere in its body (a mapping
// value, an array element, a plain member), and names are matched across
// files. A cycle reported here is read by hand; none means not affected.
//
//   node scripts/compiler-bugs/recursive-structs.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sources = new Map(); // content -> one label (identical files are scanned once)
const add = (label, content) => {
  if (typeof content === "string" && !sources.has(content)) sources.set(content, label);
};

let inputs = 0;
const readInput = (file, label) => {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const srcs = json.sources ?? json.input?.sources ?? {};
  for (const [name, s] of Object.entries(srcs)) add(`${label}:${name}`, s.content);
  inputs += 1;
};
const deployments = path.join(root, "deployments");
for (const net of fs.existsSync(deployments) ? fs.readdirSync(deployments) : []) {
  const dir = path.join(deployments, net, "solcInputs");
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) readInput(path.join(dir, f), `${net}/${f.slice(0, 8)}`);
}
const buildInfo = path.join(root, "artifacts", "build-info");
for (const f of fs.existsSync(buildInfo) ? fs.readdirSync(buildInfo) : []) {
  if (f.endsWith(".json")) readInput(path.join(buildInfo, f), `build/${f.slice(0, 8)}`);
}
// The proxies and the ProxyAdmin are bytecode hardhat-deploy ships; its
// artifacts carry their sources.
const shipped = path.join(root, "node_modules", "hardhat-deploy", "extendedArtifacts");
let shippedArtifacts = 0;
for (const f of fs.existsSync(shipped) ? fs.readdirSync(shipped) : []) {
  if (!f.endsWith(".json")) continue;
  const { metadata } = JSON.parse(fs.readFileSync(path.join(shipped, f), "utf8"));
  if (typeof metadata !== "string") continue;
  for (const [name, s] of Object.entries(JSON.parse(metadata).sources ?? {})) add(`hardhat-deploy/${f}:${name}`, s.content);
  shippedArtifacts += 1;
}
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith(".sol")) add(`tree:${path.relative(root, full).replace(/\\/g, "/")}`, fs.readFileSync(full, "utf8"));
  }
};
walk(path.join(root, "contracts"));

// Every version of every Solidity file the repository ever held (contracts
// deployed by script were built from the tree of their day, not from a
// recorded input).
let history = 0;
const list = spawnSync("git", ["rev-list", "--all", "--objects", "--", "contracts"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });
if (list.status === 0) {
  const blobs = new Map();
  for (const line of list.stdout.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0 && line.endsWith(".sol")) blobs.set(line.slice(0, at), line.slice(at + 1));
  }
  const out = spawnSync("git", ["cat-file", "--batch"], { cwd: root, input: [...blobs.keys()].join("\n") + "\n", maxBuffer: 1 << 30 }).stdout;
  let pos = 0;
  while (out && pos < out.length) {
    const eol = out.indexOf(10, pos);
    const [sha, type, size] = out.subarray(pos, eol).toString("utf8").split(" ");
    if (type !== "blob") break;
    add(`history:${blobs.get(sha)}@${sha.slice(0, 8)}`, out.subarray(eol + 1, eol + 1 + Number(size)).toString("utf8"));
    history += 1;
    pos = eol + 1 + Number(size) + 1;
  }
}

// Comments and strings out, then every `struct Name { body }` (a struct body holds no braces).
const strip = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
const search = (files) => {
  const structs = new Map(); // name -> { bodies: [..], where: [..] }
  for (const [content, label] of files) {
    for (const m of strip(content).matchAll(/\bstruct\s+([A-Za-z_$][\w$]*)\s*\{([^{}]*)\}/g)) {
      const entry = structs.get(m[1]) ?? { bodies: [], where: [] };
      entry.bodies.push(m[2]);
      entry.where.push(label);
      structs.set(m[1], entry);
    }
  }
  // name -> names of structs its bodies mention.
  const names = [...structs.keys()];
  const edges = new Map();
  for (const [name, { bodies }] of structs) {
    const words = new Set(bodies.flatMap((b) => b.match(/[A-Za-z_$][\w$]*/g) ?? []));
    edges.set(name, names.filter((n) => words.has(n)));
  }
  const reaches = (from, to, seen = new Set()) => {
    for (const next of edges.get(from) ?? []) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        if (reaches(next, to, seen)) return true;
      }
    }
    return false;
  };
  return { structs, names, edges, recursive: names.filter((n) => reaches(n, n)) };
};

// The search against planted cases, on every run: a struct with an array of
// itself, two structs that reach each other across files, and two that do
// not. A search that misses one of the first or reports the last is broken.
const planted = search(
  new Map([
    ["contract P { struct Tree { uint256 value; Tree[] children; } }", "planted:direct"],
    ["struct Left { uint256 a; Right[] rights; } // struct Fake { Fake[] f; }", "planted:left"],
    ["library L { struct Right { mapping(uint256 => Left) lefts; } struct Plain { uint256[] xs; address who; } }", "planted:right"],
  ]),
).recursive.sort();
if (planted.join() !== "Left,Right,Tree") throw new Error(`The struct search is broken: it found [${planted.join()}] in the planted cases, not Left, Right and Tree.`);

const { structs, names, edges, recursive } = search(sources);

console.log(
  `${inputs} compiler inputs, ${shippedArtifacts} artifacts shipped by hardhat-deploy, the tree and ${history} file versions from the repository's history: ${sources.size} distinct source files, ${names.length} struct names.`,
);
if (recursive.length === 0) {
  console.log("No struct refers to its own type, directly or through other structs: the recursive struct copy bug has nothing to act on.");
} else {
  console.log(`${recursive.length} struct(s) can reach their own type; read each by hand:`);
  for (const n of recursive) console.log(`  ${n}: mentions ${edges.get(n).join(", ")}; in ${[...new Set(structs.get(n).where)].slice(0, 4).join(", ")}`);
  process.exitCode = 1;
}
