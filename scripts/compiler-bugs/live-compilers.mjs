// Which compiler built every contract recorded for a network
// (contract-addresses.json), read from the chain (the solc version in the
// metadata at the end of the runtime code), and whether that code is the
// current source tree's build (immutables masked). Implementations a proxy
// points at are followed on the chain, recorded or not.
//
//   npx hardhat compile
//   node scripts/compiler-bugs/live-compilers.mjs mainnet
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildInfo, getCode, repo, rpc, walk } from "./env.mjs";

const network = process.argv[2] ?? "mainnet";

// Every address the record names for this network, with the path it sits under.
const record = JSON.parse(readFileSync(join(repo, "contract-addresses.json"), "utf8"))[network];
const named = new Map();
const collect = (node, path) => {
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === "string") {
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) {
        const label = `${path}${key === "address" ? "" : `.${key}`}`.replace(/^\./, "");
        const k = value.toLowerCase();
        if (!named.has(k)) named.set(k, []);
        named.get(k).push(label);
      }
    } else if (value && typeof value === "object") collect(value, `${path}.${key}`);
  }
};
collect(record, "");

// The current build's contracts, with the immutable positions of each.
const infos = new Map();
const local = [];
for (const f of walk(join(repo, "artifacts", "contracts")).filter((f) => f.endsWith(".dbg.json"))) {
  const artifact = JSON.parse(readFileSync(f.replace(".dbg.json", ".json"), "utf8"));
  if (artifact.deployedBytecode === "0x") continue;
  const id = JSON.parse(readFileSync(f, "utf8")).buildInfo.split(/[\\/]/).pop().replace(".json", "");
  if (!infos.has(id)) infos.set(id, buildInfo(id));
  const out = infos.get(id).output.contracts[artifact.sourceName][artifact.contractName];
  const refs = Object.values(out.evm.deployedBytecode.immutableReferences ?? {}).flat();
  local.push({ name: artifact.contractName, code: artifact.deployedBytecode.slice(2).toLowerCase(), refs });
}
const mask = (hex, refs) => {
  const chars = hex.split("");
  for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2; i += 1) chars[i] = "0";
  return chars.join("");
};
const currentBuildOf = (code) => local.find((l) => l.code.length === code.length && mask(l.code, l.refs) === mask(code, l.refs))?.name ?? null;
const solcOf = (code) => {
  const m = code.match(/64736f6c6343([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})0033$/);
  return m ? `${parseInt(m[1], 16)}.${parseInt(m[2], 16)}.${parseInt(m[3], 16)}` : null;
};
// EIP-1967: keccak256("eip1967.proxy.implementation") - 1
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const rows = [];
const read = async (address, labels) => {
  const code = await getCode(address, network);
  if (code.length === 0) return rows.push({ address, labels, account: true });
  const impl = `0x${(await rpc("eth_getStorageAt", [address, IMPL_SLOT, "latest"], network)).slice(26)}`;
  const proxy = !/^0x0{40}$/.test(impl);
  if (proxy && !named.has(impl)) named.set(impl, [`${labels[0]} (implementation read from the chain, NOT in the record)`]);
  rows.push({ address, labels, proxy, solc: solcOf(code), bytes: code.length / 2, match: currentBuildOf(code) });
};
for (const [address, labels] of [...named]) await read(address, labels);
// A second pass for implementations found only on the chain.
for (const [address, labels] of named) if (!rows.some((r) => r.address === address)) await read(address, labels);

const byVersion = new Map();
for (const r of rows) {
  const key = r.account ? "account" : r.solc ?? "no solc metadata";
  if (!byVersion.has(key)) byVersion.set(key, []);
  byVersion.get(key).push(r);
}
for (const [version, list] of [...byVersion].sort()) {
  console.log(`\n== ${version}: ${list.length}`);
  for (const r of list) {
    const tail = r.account
      ? ""
      : `  ${r.bytes} bytes  ${r.match ? `= current build of ${r.match}` : "not a current build"}${r.proxy ? "  [proxy]" : ""}`;
    console.log(`  ${r.address}  ${r.labels.join(" | ")}${tail}`);
  }
}
