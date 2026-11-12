// The compiler team's recommended check for the Yul optimizer "knowledge
// base stale bookkeeping" bug (fixed in solc 0.8.38), on the current source
// tree: compile the sources with the nightly build right before the fix
// (commit ce5702db) and the one right after (commit 8bff1c3a), same
// settings, and compare the bytecode with the metadata set aside. Identical
// bytecode means the fix changed nothing for that code under the nightly's
// optimizer: a strong indication, not a proof, for code built by 0.8.35.
//
//   npx hardhat compile
//   node scripts/compiler-bugs/get-compilers.mjs nightly
//   node scripts/compiler-bugs/tree-nightly-pair.mjs build before     (slow: one build per process)
//   node scripts/compiler-bugs/tree-nightly-pair.mjs build after
//   node scripts/compiler-bugs/tree-nightly-pair.mjs compare
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildInfo, currentBuilds, errorsOf, nightlySolc, work } from "./env.mjs";

const [mode, which] = process.argv.slice(2);
const fileOf = (name) => join(work, `tree-nightly-${name}.json`);

if (mode === "build" && (which === "before" || which === "after")) {
  const solc = nightlySolc(which);
  console.log(`${which}: ${solc.version()}`);
  const results = {};
  for (const [id, wanted] of currentBuilds()) {
    const info = buildInfo(id);
    const input = structuredClone(info.input);
    for (const s of Object.values(input.sources))
      if (s.content) s.content = s.content.replace(/pragma solidity\s+[=^]?\s*0\.8\.\d+\s*;/g, "pragma solidity >=0.8.0;");
    input.settings.outputSelection = {};
    for (const key of wanted) {
      const [source, name] = key.split(":");
      (input.settings.outputSelection[source] ??= {})[name] = ["evm.deployedBytecode.object", "evm.bytecode.object"];
    }
    const t = Date.now();
    const out = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = errorsOf(out);
    console.log(
      `  ${id.slice(0, 8)}: ${wanted.size} contracts, ${Math.round((Date.now() - t) / 1000)} s${
        errors.length ? `, ERROR ${errors[0].slice(0, 300)}` : ""
      }`
    );
    for (const key of wanted) {
      const [source, name] = key.split(":");
      const c = out.contracts?.[source]?.[name];
      results[`${id.slice(0, 8)} ${key}`] = c ? { runtime: c.evm.deployedBytecode.object, creation: c.evm.bytecode.object } : null;
    }
    writeFileSync(fileOf(which), JSON.stringify({ version: solc.version(), results }));
  }
  console.log(`${which} done: ${Object.keys(results).length} contracts`);
} else if (mode === "compare") {
  const a = JSON.parse(readFileSync(fileOf("before"), "utf8"));
  const b = JSON.parse(readFileSync(fileOf("after"), "utf8"));
  console.log(`before: ${a.version}\nafter:  ${b.version}`);
  const keys = Object.keys(a.results);
  // The two builds stamp different versions into the metadata, so the raw
  // outputs must differ everywhere, or the comparison compared nothing.
  const rawSame = keys.filter((k) => a.results[k] && b.results[k] && a.results[k].runtime === b.results[k].runtime).length;
  console.log(`identical before the metadata is set aside (must be 0): ${rawSame}`);
  // A pre-release build writes its version into the metadata as text: a2 64 "ipfs" 58 22 <34 bytes> 64 "solc" 78 <len> <text> 00 <cbor len>
  const setAside = (data) => {
    const hex = Buffer.from(data.version.replace(/\.Emscripten.*$/, ""), "ascii").toString("hex");
    const re = new RegExp(`a264697066735822[0-9a-f]{68}64736f6c6378[0-9a-f]{2}${hex}00[0-9a-f]{2}`, "g");
    for (const r of Object.values(data.results)) {
      if (!r) continue;
      r.found = (r.runtime.match(re) ?? []).length;
      r.runtime = r.runtime.replace(re, "META");
      r.creation = r.creation.replace(re, "META");
    }
  };
  setAside(a);
  setAside(b);
  let same = 0;
  let empty = 0;
  let replaced = 0;
  const differ = [];
  for (const k of keys) {
    const x = a.results[k];
    const y = b.results[k];
    if (!x || !y || !x.runtime || !y.runtime) {
      empty += 1;
      continue;
    }
    if (x.found && y.found) replaced += 1;
    if (x.runtime === y.runtime && x.creation === y.creation) same += 1;
    else differ.push(k);
  }
  console.log(`contracts in both: ${keys.length} / ${Object.keys(b.results).length}; missing or empty: ${empty}; metadata set aside in: ${replaced}`);
  console.log(`identical runtime and creation code: ${same}; different: ${differ.length}`);
  for (const k of differ) console.log(`  ${k}`);
  if (rawSame || empty || differ.length || replaced !== keys.length) process.exitCode = 1;
} else {
  throw new Error("usage: tree-nightly-pair.mjs build before|after, then compare");
}
