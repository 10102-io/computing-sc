// For contracts on mainnet that no verifier holds: find which recorded
// hardhat-deploy compiler input (deployments/<network>/solcInputs) and
// which contract in it reproduces the code on the chain (immutables are not
// masked: these contracts have none). A hit is kept in the work folder for
// live-builds.mjs. When no recorded input fits, the contract was built from
// sources between two deployments: rebuild-from-history.mjs.
//
// Only the sources that can hold the contract are compiled (a whole job
// takes minutes through the IR): the legacy contracts by default, or the
// sources matching SOURCES=<regex>.
//
//   node scripts/compiler-bugs/find-input.mjs <address>...
//   $env:SOURCES='PremiumMail'; node scripts/compiler-bugs/find-input.mjs <address>...
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { compile, errorsOf, getCode, nativeSolc, repo, withoutIpfsHash, work } from "./env.mjs";

// The compiler of every contract deployed before 2026-07-27.
const VERSION = "0.8.20";
const WANTED_SOURCES = new RegExp(
  process.env.SOURCES ?? "TransferLegacyEOAContract\\.sol|TransferEOALegacy\\.sol|MultisigLegacyContract\\.sol|MultisigLegacy\\.sol"
);

const exe = nativeSolc(VERSION);
const commit = exe.match(/commit\.([0-9a-f]{8})/)[1];
const wanted = new Map();
for (const a of process.argv.slice(2)) wanted.set(a.toLowerCase(), await getCode(a));
for (const [a, code] of wanted) {
  const m = code.match(/64736f6c6343([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})0033$/);
  console.log(
    `${a}: ${code.length / 2} bytes, solc ${
      m
        ? m
            .slice(1)
            .map((x) => parseInt(x, 16))
            .join(".")
        : "?"
    }`
  );
}
// An input that gives the same bytes wins over one that gives the same code with another metadata hash
// (the same contract compiled from a checkout whose comments or line ends differed).
const found = new Set();
const codeOnly = new Set();
const keep = (a, source, name, input, match) => {
  writeFileSync(
    join(work, "found-inputs", `${a}.json`),
    JSON.stringify({
      compilation: { compilerVersion: `${VERSION}+commit.${commit}`, fullyQualifiedName: `${source}:${name}` },
      stdJsonInput: input,
      match,
    })
  );
  console.log(`  ${a} = ${source}:${name}, ${VERSION}, ${match}`);
};
for (const network of ["mainnet", "sepolia"]) {
  const dir = join(repo, "deployments", network, "solcInputs");
  for (const file of readdirSync(dir)) {
    if (found.size === wanted.size) break;
    const input = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const picked = Object.keys(input.sources).filter((s) => WANTED_SOURCES.test(s));
    if (picked.length === 0) {
      console.log(`  ${network}/${file}: none of the sources looked for`);
      continue;
    }
    const selected = structuredClone(input);
    selected.settings.outputSelection = Object.fromEntries(picked.map((s) => [s, { "*": ["evm.deployedBytecode.object"] }]));
    const out = await compile(exe, selected);
    if (errorsOf(out).length) {
      console.log(`  ${network}/${file}: does not compile with ${VERSION}`);
      continue;
    }
    let count = 0;
    for (const [source, contracts] of Object.entries(out.contracts ?? {})) {
      for (const [name, c] of Object.entries(contracts)) {
        count += 1;
        const code = c.evm.deployedBytecode.object.toLowerCase();
        for (const [a, onChain] of wanted) {
          if (found.has(a)) continue;
          const record = `deployments/${network}/solcInputs/${file}`;
          if (code === onChain) {
            found.add(a);
            keep(a, source, name, input, record);
          } else if (!codeOnly.has(a) && withoutIpfsHash(code) === withoutIpfsHash(onChain)) {
            codeOnly.add(a);
            keep(a, source, name, input, `${record} (metadata hash differs)`);
          }
        }
      }
    }
    console.log(`  tried ${network}/${file}: ${count} contracts, viaIR ${input.settings.viaIR === true}`);
  }
}
for (const a of wanted.keys()) {
  if (found.has(a)) continue;
  console.log(codeOnly.has(a) ? `same code, no input with the same metadata hash: ${a}` : `NOT FOUND: ${a}`);
  if (!codeOnly.has(a)) process.exitCode = 1;
}
