// Mutual recursion screen of the current source tree, for the two "spill"
// compiler bugs (fixed in solc 0.8.36 and 0.8.37). Compiles the exact inputs
// behind the current artifacts with the compiler that built them, builds the
// call graph of every Yul object from the unoptimized and from the optimized
// IR and lists every cycle of two or more functions. It also lists the
// contracts in which the compiler moved variables to memory at all, the
// settings of the builds, and what three more known bugs need in the source
// text.
//
//   npx hardhat compile
//   node scripts/compiler-bugs/tree-call-graph.mjs
import { assertSearchWorks, memoryMoved, recursion } from "./call-graph.mjs";
import { buildInfo, compile, currentBuilds, nativeSolc, sourcePatterns } from "./env.mjs";

assertSearchWorks();

let contracts = 0;
const totals = {
  plain: { objects: 0, functions: 0, calls: 0, mutual: [], self: [] },
  optimized: { objects: 0, functions: 0, calls: 0, mutual: [], self: [] },
};
const moved = [];
const versions = new Set();
const settings = new Set();
const sourceNames = new Set();
const inText = { namedErrorInRequire: 0, layoutAt: 0, verbatim: 0 };
for (const [id, wanted] of currentBuilds()) {
  const info = buildInfo(id);
  versions.add(info.solcVersion);
  settings.add(
    `optimizer ${JSON.stringify(info.input.settings.optimizer)}, viaIR ${info.input.settings.viaIR === true}, EVM ${
      info.input.settings.evmVersion ?? "default"
    }`
  );
  const text = sourcePatterns(info.input.sources);
  for (const key of Object.keys(inText)) inText[key] += text[key];
  for (const source of Object.keys(info.input.sources)) sourceNames.add(source);
  const input = structuredClone(info.input);
  input.settings.outputSelection = {};
  for (const key of wanted) {
    const [source, name] = key.split(":");
    (input.settings.outputSelection[source] ??= {})[name] = ["ir", "irOptimized"];
  }
  const out = await compile(nativeSolc(info.solcVersion), input);
  for (const key of wanted) {
    const [source, name] = key.split(":");
    const built = out.contracts?.[source]?.[name];
    if (!built?.ir || !built?.irOptimized) {
      console.log(`no IR for ${key}`);
      process.exitCode = 1;
      continue;
    }
    contracts += 1;
    const memory = memoryMoved(built.ir, built.irOptimized);
    if (memory.moved) moved.push(`${name}: ${memory.text}`);
    for (const [which, code] of [
      ["plain", built.ir],
      ["optimized", built.irOptimized],
    ]) {
      const found = recursion(code);
      const total = totals[which];
      total.objects += found.objects;
      total.functions += found.functions;
      total.calls += found.calls;
      total.mutual.push(...found.mutual.map((m) => `${key} ${m}`));
      total.self.push(...found.self.map((m) => `${key} ${m}`));
    }
  }
}
console.log(`${contracts} contracts, solc ${[...versions].join(", ")}; settings: ${[...settings].join(" | ")}`);
// Counted once per build that holds a source, so a count above zero is a find, not a number of places.
console.log(
  `In the ${sourceNames.size} sources of those builds, dependencies included: require with a named-argument error ${inText.namedErrorInRequire}, layout at ${inText.layoutAt}, verbatim ${inText.verbatim}`
);
for (const [which, label] of [
  ["plain", "Unoptimized IR"],
  ["optimized", "Optimized IR"],
]) {
  const total = totals[which];
  console.log(`${label}: ${total.objects} Yul objects, ${total.functions} functions, ${total.calls} calls between them`);
  console.log(`  cycles of two or more functions (what both spill bugs need): ${total.mutual.length}`);
  for (const m of total.mutual) console.log(`    ${m}`);
  console.log(`  functions that call themselves (not the bugs' condition, listed for the record): ${total.self.length}`);
  for (const m of total.self) console.log(`    ${m}`);
}
console.log(`Contracts where the compiler moved variables to memory (the mover both bugs sit in; sound without a cycle): ${moved.length}`);
for (const m of moved.sort()) console.log(`  ${m}`);
if (totals.plain.mutual.length || totals.optimized.mutual.length || inText.namedErrorInRequire || inText.layoutAt || inText.verbatim)
  process.exitCode = 1;
