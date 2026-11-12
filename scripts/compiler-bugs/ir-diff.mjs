// The optimized IR of chosen contracts of the current tree under two
// compiler releases, written to the work folder for a text diff: what a
// release changed in a contract, in readable form. Used to see that the
// differences 0.8.37 makes are the optimizer moving loop-invariant
// expressions out of loops, and at a compiler upgrade.
//
//   node scripts/compiler-bugs/ir-diff.mjs 0.8.36 0.8.37 MultisigLegacy PremiumSetting
//   git diff --no-index <work>/ir-diff/MultisigLegacy.0.8.36.yul <work>/ir-diff/MultisigLegacy.0.8.37.yul
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildInfo, compile, currentBuilds, nativeSolc, work } from "./env.mjs";

const [verA, verB, ...names] = process.argv.slice(2);
if (names.length === 0) throw new Error("usage: ir-diff.mjs <version> <version> <ContractName>...");
const outDir = join(work, "ir-diff");
mkdirSync(outDir, { recursive: true });

for (const [id, wanted] of currentBuilds()) {
  for (const key of wanted) {
    const [source, name] = key.split(":");
    if (!names.includes(name)) continue;
    const input = structuredClone(buildInfo(id).input);
    for (const s of Object.values(input.sources))
      if (s.content) s.content = s.content.replace(/pragma solidity\s+[=^]?\s*0\.8\.\d+\s*;/g, "pragma solidity >=0.8.0;");
    input.settings.outputSelection = { [source]: { [name]: ["irOptimized"] } };
    for (const v of [verA, verB]) {
      const out = await compile(nativeSolc(v), input);
      const ir = (out.contracts?.[source]?.[name]?.irOptimized ?? "")
        // Source-location comments differ in nothing that matters and drown the diff.
        .replace(/\/\/\/ @src[^\n]*\n/g, "")
        .replace(/\/\*\*[\s\S]*?\*\//g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{2,}/g, "\n")
        // The metadata blob carries the build's hash.
        .replace(/data "\.metadata" hex"[0-9a-f]+"/g, 'data ".metadata" hex"META"');
      const file = join(outDir, `${name}.${v}.yul`);
      writeFileSync(file, ir);
      console.log(`${name} ${v}: ${ir.length} characters, ${file}`);
    }
  }
}
