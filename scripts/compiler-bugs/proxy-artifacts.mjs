// The proxies and the ProxyAdmin on a network are not built from this
// repository: hardhat-deploy deploys the bytecode it ships (OpenZeppelin's
// transparent proxy, solc 0.8.10, no viaIR). This checks that the code on
// the chain IS that shipped bytecode: every proxy equals the artifact apart
// from the one immutable (the admin), which must hold the DefaultProxyAdmin
// address, and the ProxyAdmin equals its artifact exactly.
//
//   node scripts/compiler-bugs/proxy-artifacts.mjs mainnet
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getCode, repo, require, rpc } from "./env.mjs";

const network = process.argv[2] ?? "mainnet";
const record = JSON.parse(readFileSync(join(repo, "contract-addresses.json"), "utf8"))[network];
const shipped = (name) => require(`hardhat-deploy/extendedArtifacts/${name}.json`);
const describe = (artifact) => {
  const meta = JSON.parse(artifact.metadata);
  return `solc ${meta.compiler.version}, optimizer ${JSON.stringify(meta.settings.optimizer)}, viaIR ${meta.settings.viaIR === true}`;
};
const proxyArtifact = shipped("OptimizedTransparentUpgradeableProxy");
const adminArtifact = shipped("ProxyAdmin");
console.log(`hardhat-deploy ${require("hardhat-deploy/package.json").version}`);
console.log(`  OptimizedTransparentUpgradeableProxy: ${describe(proxyArtifact)}`);
console.log(`  ProxyAdmin: ${describe(adminArtifact)}`);

// What the known bugs of that compiler need, counted in the shipped sources (comments stripped).
const NEEDS = {
  "delete (MemoryByteArrayElementDeleteClearsWholeWord)": /\bdelete\b/g,
  ".selector (MissingSideEffectsOnSelectorAccess)": /\.selector\b/g,
  "verbatim (VerbatimInvalidDeduplication)": /\bverbatim\b/g,
  "array in calldata (AbiReencodingHeadOverflowWithStaticArrayCleanup, NestedCalldataArrayAbiReencodingSizeValidation)": /\]\s*calldata\b/g,
  "array, bytes or string state variable (DirtyBytesArrayToStorage, LostStorageArrayWriteOnSlotOverflow)":
    /^\s*(bytes|string|[\w.]+\s*\[\d*\])\s+(public\s+|private\s+|internal\s+)?\w+\s*(=[^;]*)?;/gm,
  "override with parameters (DataLocationChangeInInternalOverride)": /function\s+\w+\s*\([^)]+\)[^{;]*\boverride\b/g,
};
for (const [name, artifact] of [
  ["OptimizedTransparentUpgradeableProxy", proxyArtifact],
  ["ProxyAdmin", adminArtifact],
]) {
  const meta = JSON.parse(artifact.metadata);
  const sources = Object.values(meta.sources).map((s) => (s.content ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""));
  if (sources.some((s) => s === "")) throw new Error(`${name}: the artifact does not hold its sources`);
  console.log(
    `  ${name}, ${sources.length} sources, own optimizer step sequence: ${meta.settings.optimizer.details?.yulDetails?.optimizerSteps ? "YES" : "no"}`
  );
  for (const [what, re] of Object.entries(NEEDS)) console.log(`    ${what}: ${sources.reduce((n, s) => n + (s.match(re) ?? []).length, 0)}`);
}

const admin = record.DefaultProxyAdmin?.address ?? record.DefaultProxyAdmin;
const adminCode = await getCode(admin, network);
const adminSame = adminCode === adminArtifact.deployedBytecode.slice(2).toLowerCase();
console.log(`\nDefaultProxyAdmin ${admin}: ${adminCode.length / 2} bytes, equals the shipped ProxyAdmin: ${adminSame}`);

// EIP-1967: keccak256("eip1967.proxy.implementation") - 1
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const shippedProxy = proxyArtifact.deployedBytecode.slice(2).toLowerCase();
const adminWord = admin.slice(2).toLowerCase().padStart(64, "0");
let proxies = 0;
let bad = adminSame ? 0 : 1;
for (const [name, entry] of Object.entries(record)) {
  const address = entry?.address;
  if (typeof address !== "string") continue;
  const impl = await rpc("eth_getStorageAt", [address, IMPL_SLOT, "latest"], network);
  if (/^0x0{64}$/.test(impl)) continue;
  proxies += 1;
  const code = await getCode(address, network);
  // The immutable is a zero word in the artifact; on the chain every difference must be that word holding the admin.
  let ok = code.length === shippedProxy.length;
  let filled = 0;
  for (let i = 0; ok && i < code.length; i += 2) {
    if (code.slice(i, i + 2) === shippedProxy.slice(i, i + 2)) continue;
    // The differing byte must sit in a 32-byte word that is zero in the artifact and the admin on the chain.
    let start = -1;
    for (let s = Math.max(0, i - 62); s <= i && start < 0; s += 2) {
      if (/^0{64}$/.test(shippedProxy.slice(s, s + 64)) && code.slice(s, s + 64) === adminWord) start = s;
    }
    if (start < 0) ok = false;
    else {
      filled += 1;
      i = start + 62;
    }
  }
  if (!ok || filled === 0) bad += 1;
  console.log(
    `  ${address} ${name}: ${code.length / 2} bytes, ${
      ok && filled ? `the shipped proxy, admin immutable set in ${filled} places` : "NOT the shipped proxy"
    }`
  );
}
console.log(`\n${proxies} proxies, ${bad} with something to look at`);
if (bad) process.exitCode = 1;
