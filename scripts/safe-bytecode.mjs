// The code the guard is tested with: the runtime bytecode of the canonical Safe singleton, proxy factory,
// compatibility fallback handler and MultiSendCallOnly, versions 1.3.0, 1.4.1 and 1.5.0, as it stands on mainnet, and of one
// version 1 guard (the guard every Safe legacy got before 2026-11). The spec (test/SafeGuard.spec.ts)
// places these bytes at their addresses, so a Safe in the tests is the Safe users have, the call that
// moved a version 1 guard is shown to move one, and nothing of Safe's enters this repository's build.
// Read-only, no key, nothing from .env.
//
//   node scripts/safe-bytecode.mjs           check test/fixtures/safe-bytecode.json against mainnet
//   node scripts/safe-bytecode.mjs --write   fetch and write it
//   MAINNET_RPC_URL=<your node> node scripts/safe-bytecode.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(repo, "test", "fixtures", "safe-bytecode.json");
const { keccak256 } = createRequire(import.meta.url)("ethers").utils;

// Canonical addresses, as listed in @safe-global/safe-deployments for chain 1.
const SAFES = {
  "1.3.0": {
    singleton: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
    factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    multiSendCallOnly: "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  },
  "1.4.1": {
    singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  },
  "1.5.0": {
    singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
    factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
    fallbackHandler: "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
    multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
  },
  // The guard of the first Safe legacy on mainnet. The three guards deployed before version 2 share
  // this code (docs/security/compiler-known-bugs.md).
  "guard-v1": {
    guard: "0xa1cdBd3B0C95a8396cA233960a885aeD21E20285",
  },
};

const RPCS = [process.env.MAINNET_RPC_URL, "https://eth.drpc.org", "https://ethereum-rpc.publicnode.com", "https://eth.merkle.io"].filter(Boolean);
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      return body.result;
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`${method}: no node answered (${last?.message})`);
}

const write = process.argv.includes("--write");
const stored = write ? {} : JSON.parse(readFileSync(file, "utf8"));
let failed = false;
for (const [version, parts] of Object.entries(SAFES)) {
  if (write) stored[version] = {};
  for (const [part, address] of Object.entries(parts)) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (!code || code === "0x") throw new Error(`${version} ${part} ${address}: no code on mainnet`);
    const codeHash = keccak256(code);
    if (write) {
      stored[version][part] = { address, codeHash, code };
      console.log(`${version} ${part.padEnd(15)} ${address} ${code.length / 2 - 1} bytes ${codeHash}`);
      continue;
    }
    const have = stored[version]?.[part];
    const ok = have && have.address === address && have.code === code && have.codeHash === codeHash && keccak256(have.code) === have.codeHash;
    console.log(`${ok ? "ok      " : "DIFFERS "}${version} ${part.padEnd(15)} ${address} ${code.length / 2 - 1} bytes ${codeHash}`);
    if (!ok) failed = true;
  }
}
if (write) {
  writeFileSync(file, JSON.stringify(stored, null, 2) + "\n");
  console.log(`written: ${file}`);
} else if (failed) {
  console.error("the fixture is not the code on mainnet: run with --write and read the difference");
  process.exit(1);
} else {
  console.log("all checks passed");
}
