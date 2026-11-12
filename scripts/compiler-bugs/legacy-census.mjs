// Every legacy contract the two mainnet routers ever created, grouped by the
// code it runs: an EIP-1167 clone of an implementation, or its own full
// bytecode (grouped by code hash), with the compiler read from the metadata.
// Multisig legacies also have a Safe guard each. These contracts are in no
// address record: the routers' `legacyAddresses(id)` is the only list.
//
//   node scripts/compiler-bugs/legacy-census.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getCode, repo, require, rpc, work } from "./env.mjs";

const { keccak256, id: selectorOf, hexZeroPad, hexlify } = require("ethers").utils;
const call = (to, signature, arg) =>
  rpc("eth_call", [{ to, data: selectorOf(signature).slice(0, 10) + hexZeroPad(hexlify(arg), 32).slice(2) }, "latest"]);
const solcOf = (code) => {
  const m = code.match(/64736f6c6343([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})0033$/);
  return m ? `${parseInt(m[1], 16)}.${parseInt(m[2], 16)}.${parseInt(m[3], 16)}` : "?";
};
const record = JSON.parse(readFileSync(join(repo, "contract-addresses.json"), "utf8")).mainnet;
const routers = { EOA: record.TransferEOALegacyRouter.address, Multisig: record.MultisigLegacyRouter.address };

const groups = new Map();
const add = (key, entry) => {
  if (!groups.has(key)) groups.set(key, { ...entry, count: 0, addresses: [] });
  const g = groups.get(key);
  g.count += 1;
  g.addresses.push(entry.example);
};
for (const [kind, router] of Object.entries(routers)) {
  let zeros = 0;
  let total = 0;
  // Ids are handed out in order; eight empty ids in a row end the list.
  for (let legacyId = 1; zeros < 8; legacyId += 1) {
    const address = `0x${(await call(router, "legacyAddresses(uint256)", legacyId)).slice(26)}`;
    if (/^0x0{40}$/.test(address)) {
      zeros += 1;
      continue;
    }
    zeros = 0;
    total += 1;
    const targets = [[`${kind} legacy`, address]];
    if (kind === "Multisig") {
      const guard = `0x${(await call(router, "guardAddresses(uint256)", legacyId)).slice(26)}`;
      if (!/^0x0{40}$/.test(guard)) targets.push(["Multisig guard", guard]);
    }
    for (const [what, target] of targets) {
      const code = await getCode(target);
      const clone = code.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
      const example = `${legacyId}:${target}`;
      if (code.length === 0) add(`${what}: no code`, { what, shape: "no code (destroyed or never deployed)", example });
      else if (clone) add(`${what}: clone ${clone[1]}`, { what, shape: "clone", implementation: `0x${clone[1]}`, example });
      else add(`${what}: full ${keccak256(`0x${code}`)}`, { what, shape: "full bytecode", solc: solcOf(code), bytes: code.length / 2, example });
    }
  }
  console.log(`${kind} router ${router}: ${total} legacies recorded`);
}
const rows = [...groups.values()];
for (const g of rows) {
  if (g.shape === "clone") {
    const code = await getCode(g.implementation);
    g.solc = solcOf(code);
    g.bytes = code.length / 2;
  }
  console.log(
    `  ${g.count} x ${g.what}: ${g.shape}${g.implementation ? ` of ${g.implementation}` : ""}, solc ${g.solc ?? "-"}, ${
      g.bytes ?? 0
    } bytes, e.g. ${g.addresses.slice(0, 2).join(", ")}`
  );
}
writeFileSync(join(work, "legacy-census.json"), JSON.stringify(rows, null, 2));
console.log(`every address by group: ${join(work, "legacy-census.json")}`);
