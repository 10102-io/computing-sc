// The checks of the current tree, for a contract on mainnet that the tree no
// longer builds (an older implementation, a legacy from before the clones).
// Its verified compiler input comes from Sourcify, or from the work folder
// when it was found here (find-input.mjs, rebuild-from-history.mjs):
//   0. its settings: viaIR on, the default optimizer step sequence
//   1. recompiled with its own compiler it equals the code on the chain
//      (immutables masked; a metadata-only difference is said)
//   2. a 0.8.35 build gives the same bytecode under 0.8.36
//   3. no cycle in the Yul call graph, unoptimized and optimized; where
//      there is one, whether the compiler moved any variable to memory at
//      all (both spill bugs need the cycle and the move)
//   4. the nightly builds before and after the 0.8.38 optimizer fix agree
//
//   node scripts/compiler-bugs/get-compilers.mjs 0.8.36 nightly
//   node scripts/compiler-bugs/live-builds.mjs <address>...
import { assertSearchWorks, memoryMoved, recursion } from "./call-graph.mjs";
import { compile, errorsOf, getCode, inputOf, nativeSolc, nightlyMeta, nightlySolc, RELEASE_META, sourcePatterns, withoutIpfsHash } from "./env.mjs";

assertSearchWorks();
const before = nightlySolc("before");
const after = nightlySolc("after");

const summary = [];
for (const address of process.argv.slice(2)) {
  let record;
  try {
    record = await inputOf(address);
  } catch (err) {
    console.log(`\n${address}: ${err.message}`);
    summary.push({ address, name: "?", verified: false });
    continue;
  }
  const [source, name] = record.compilation.fullyQualifiedName.split(":");
  const built = record.compilation.compilerVersion.split("+commit.")[0];
  console.log(`\n${address}  ${name}  (${record.compilation.compilerVersion}; input: ${record.from})`);
  const input = record.stdJsonInput;
  const withOutputs = (outputs, anyCompiler) => {
    const i = structuredClone(input);
    if (anyCompiler)
      for (const s of Object.values(i.sources))
        if (s.content) s.content = s.content.replace(/pragma solidity\s+[=^]?\s*0\.8\.\d+\s*;/g, "pragma solidity >=0.8.0;");
    i.settings.outputSelection = { [source]: { [name]: outputs } };
    return i;
  };
  const row = { address, name, built, verified: true, viaIR: input.settings.viaIR === true };
  // Two known bugs depend on the settings alone: one needs the old code generator (viaIR off), one an own optimizer step sequence.
  row.ownSteps = typeof input.settings.optimizer?.details?.yulDetails?.optimizerSteps === "string";
  // Three more need a construct in the source text, counted over every source of the input.
  const text = sourcePatterns(input.sources);
  row.textFindings = text.namedErrorInRequire + text.layoutAt + text.verbatim;
  console.log(
    `  0. optimizer ${JSON.stringify(input.settings.optimizer)}, viaIR ${row.viaIR}, EVM ${
      input.settings.evmVersion ?? "default"
    }, own optimizer step sequence: ${row.ownSteps ? "YES" : "no"}; ` +
      `in ${Object.keys(input.sources).length} sources: require with a named-argument error ${text.namedErrorInRequire}, layout at ${
        text.layoutAt
      }, verbatim ${text.verbatim}`
  );

  // 1. Its own compiler again, against the chain.
  const own = await compile(
    nativeSolc(built),
    withOutputs(["evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences", "evm.bytecode.object", "ir", "irOptimized"], false)
  );
  if (errorsOf(own).length) throw new Error(errorsOf(own)[0]);
  const c = own.contracts[source][name];
  const refs = Object.values(c.evm.deployedBytecode.immutableReferences ?? {}).flat();
  const mask = (hex) => {
    const chars = hex.split("");
    for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2; i += 1) chars[i] = "0";
    return chars.join("");
  };
  const chain = await getCode(address);
  row.bytes = chain.length / 2;
  row.reproduced = mask(chain) === mask(c.evm.deployedBytecode.object);
  if (!row.reproduced) {
    // The same code with another metadata hash: a comment or a path differed in the verified input.
    row.reproduced = withoutIpfsHash(mask(chain)) === withoutIpfsHash(mask(c.evm.deployedBytecode.object));
    row.metadataDiffers = row.reproduced;
  }
  console.log(
    `  1. ${built} rebuild equals the ${row.bytes} bytes on the chain (${refs.length} immutable positions masked${
      row.metadataDiffers ? "; only the metadata hash differs" : ""
    }): ${row.reproduced}`
  );

  // 2. 0.8.36, which fixed the first spill bug and one more (only meaningful for a 0.8.35 build).
  row.same36 = true;
  if (built === "0.8.35") {
    const next = await compile(nativeSolc("0.8.36"), withOutputs(["evm.deployedBytecode.object", "evm.bytecode.object"], true));
    if (errorsOf(next).length) throw new Error(errorsOf(next)[0]);
    const n = next.contracts[source][name];
    row.same36 =
      c.evm.deployedBytecode.object.replace(RELEASE_META, "M") === n.evm.deployedBytecode.object.replace(RELEASE_META, "M") &&
      c.evm.bytecode.object.replace(RELEASE_META, "M") === n.evm.bytecode.object.replace(RELEASE_META, "M");
    console.log(`  2. identical under 0.8.36: ${row.same36}`);
  }

  // 3. The call graph, and what the stack-to-memory mover did.
  const plain = recursion(c.ir);
  const optimized = recursion(c.irOptimized);
  for (const m of plain.mutual) console.log(`     cycle, unoptimized IR: ${m}`);
  for (const m of optimized.mutual) console.log(`     cycle, optimized IR: ${m}`);
  const memory = memoryMoved(c.ir, c.irOptimized);
  row.mutual = plain.mutual.length;
  row.mutualOptimized = optimized.mutual.length;
  row.movedToMemory = memory.moved;
  // Both bugs need a cycle AND variables moved to memory.
  row.spillBugsApply = (row.mutual > 0 || row.mutualOptimized > 0) && row.movedToMemory;
  console.log(
    `  3. cycles of two or more functions: ${row.mutual} in the unoptimized IR (${plain.objects} objects, ${plain.functions} functions, ${plain.calls} calls), ` +
      `${row.mutualOptimized} in the optimized IR (${optimized.functions} functions, ${optimized.calls} calls); ` +
      `functions that call themselves (not the bugs' condition): ${plain.self.length} and ${optimized.self.length}; ${memory.text}`
  );

  // 4. The nightly pair.
  const sel = JSON.stringify(withOutputs(["evm.deployedBytecode.object", "evm.bytecode.object"], true));
  const ob = JSON.parse(before.compile(sel));
  const oa = JSON.parse(after.compile(sel));
  if (errorsOf(ob).length || errorsOf(oa).length) {
    row.nightlySame = null;
    console.log(`  4. the nightly builds do not compile this source: ${(errorsOf(ob)[0] ?? errorsOf(oa)[0]).slice(0, 300)}`);
    summary.push(row);
    continue;
  }
  const cb = ob.contracts[source][name].evm;
  const ca = oa.contracts[source][name].evm;
  const mb = nightlyMeta(before);
  const ma = nightlyMeta(after);
  // One trailer for the contract itself and one for each contract it creates: the same number in both builds, and at least one.
  const trailers = [(cb.deployedBytecode.object.match(mb) ?? []).length, (ca.deployedBytecode.object.match(ma) ?? []).length];
  row.nightlySame =
    cb.deployedBytecode.object.replace(mb, "M") === ca.deployedBytecode.object.replace(ma, "M") &&
    cb.bytecode.object.replace(mb, "M") === ca.bytecode.object.replace(ma, "M");
  // The two builds stamp different versions, so the raw outputs must differ, or nothing was compared.
  const rawDiffer = cb.deployedBytecode.object !== ca.deployedBytecode.object;
  console.log(
    `  4. nightly before and after the fix agree: ${row.nightlySame} (metadata trailers set aside: ${trailers.join(
      " and "
    )}; raw outputs differ as they must: ${rawDiffer})`
  );
  if (!rawDiffer || trailers[0] === 0 || trailers[0] !== trailers[1]) row.nightlySame = false;
  summary.push(row);
}

console.log("");
for (const r of summary) {
  console.log(
    r.verified
      ? `  ${r.address} ${r.name} ${r.built}: reproduced ${r.reproduced}${r.metadataDiffers ? " (metadata hash differs)" : ""}, cycles ${
          r.mutual
        } unoptimized and ${r.mutualOptimized} optimized, ` +
          `moved to memory ${r.movedToMemory}, nightly pair ${r.nightlySame ?? "does not compile"}`
      : `  ${r.address}: no verified input`
  );
}
// A source the nightlies cannot compile is a limit to record, not a finding; everything else must hold.
const open = summary.filter(
  (r) => !r.verified || !r.viaIR || r.ownSteps || r.textFindings || !r.reproduced || !r.same36 || r.spillBugsApply || r.nightlySame === false
);
console.log(
  `\n${summary.length} contracts, ${open.length} with something to look at${open.length ? `: ${open.map((r) => r.address).join(", ")}` : ""}`
);
if (open.length) process.exitCode = 1;
