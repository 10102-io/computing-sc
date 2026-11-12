// Differential compile of the current source tree: the exact compiler
// inputs behind the current artifacts, compiled with the pinned solc and
// with later releases, same settings. Runtime and creation code are compared
// after the metadata trailer (ipfs hash and compiler version) is replaced by
// a marker. Equal code from a release that fixed a compiler bug means the
// bug changed nothing in that contract. It is also the first step of a
// compiler upgrade (docs/plans/solc-upgrade.md): what the new release changes.
//
//   npx hardhat compile
//   node scripts/compiler-bugs/get-compilers.mjs 0.8.36 0.8.37 0.8.38
//   node scripts/compiler-bugs/tree-version-diff.mjs 0.8.36 0.8.37 0.8.38
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildInfo, compile, currentBuilds, errorsOf, nativeSolc, RELEASE_META, work } from "./env.mjs";

const later = process.argv.slice(2);
if (later.length === 0) throw new Error("name the later releases to compare with, e.g. 0.8.36 0.8.37 0.8.38");

const results = {};
const started = Date.now();
let pinned = null;
for (const [id, wanted] of currentBuilds()) {
  const info = buildInfo(id);
  pinned = info.solcVersion;
  const input = structuredClone(info.input);
  // The sources pin the compiler exactly; later releases must be allowed to read them.
  const exact = new RegExp(`pragma solidity\\s+=?\\s*${pinned.replace(/\./g, "\\.")}\\s*;`, "g");
  for (const s of Object.values(input.sources)) if (s.content) s.content = s.content.replace(exact, `pragma solidity ^${pinned};`);
  input.settings.outputSelection = {};
  for (const key of wanted) {
    const [source, name] = key.split(":");
    (input.settings.outputSelection[source] ??= {})[name] = ["evm.deployedBytecode.object", "evm.bytecode.object"];
  }
  console.log(`${id.slice(0, 8)}: ${wanted.size} contracts, compiling with ${[pinned, ...later].join(", ")} ...`);
  const outs = await Promise.all(
    [pinned, ...later].map(async (v) => {
      const t = Date.now();
      const out = await compile(nativeSolc(v), input);
      const errors = errorsOf(out);
      console.log(`  ${v}: ${Math.round((Date.now() - t) / 1000)} s${errors.length ? `, ERRORS: ${errors[0].slice(0, 300)}` : ""}`);
      return [v, out];
    })
  );
  for (const key of wanted) {
    const [source, name] = key.split(":");
    const per = {};
    for (const [v, out] of outs) {
      const c = out.contracts?.[source]?.[name];
      per[v] = c
        ? { runtime: c.evm.deployedBytecode.object.replace(RELEASE_META, "META"), creation: c.evm.bytecode.object.replace(RELEASE_META, "META") }
        : null;
    }
    results[`${id.slice(0, 8)} ${key}`] = per;
  }
}
writeFileSync(join(work, "tree-version-diff.json"), JSON.stringify(results));

let same = 0;
const differing = [];
for (const [key, per] of Object.entries(results)) {
  const base = per[pinned];
  if (!base || base.runtime === "") {
    console.log(`  no code from ${pinned} for ${key}`);
    process.exitCode = 1;
    continue;
  }
  const diff = later.filter((v) => !per[v] || per[v].runtime !== base.runtime || per[v].creation !== base.creation);
  if (diff.length === 0) same += 1;
  else differing.push({ key, bytes: base.runtime.length / 2, diff });
}
console.log(`\n${same} contracts: identical under ${[pinned, ...later].join(", ")} (metadata aside).`);
console.log(`${differing.length} differ:`);
for (const d of differing) console.log(`  ${d.key} (${d.bytes} bytes): differs under ${d.diff.join(", ")}`);
console.log(`Total ${Math.round((Date.now() - started) / 1000)} s; the code of every release is in ${join(work, "tree-version-diff.json")}`);
