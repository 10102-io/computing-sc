/**
 * Print a flat, sorted, easy-to-scan view of contract-addresses.json for
 * a given network. Avoids the misreads we got from grepping the raw
 * file (where unrelated network sections can blend together visually).
 *
 * Usage:
 *   npx hardhat run scripts/print-addresses.ts --network mainnet
 *   npx hardhat run scripts/print-addresses.ts --network sepolia
 *
 * Pure read-only; sends no transactions.
 *
 * Sections:
 *   ACTIVE       — currently-wired contracts (with impl addresses where
 *                  applicable; an "(impl)" row is rendered below each
 *                  proxy for quick reference).
 *   DEPRECATED   — entries archived under _deprecated{} with notes.
 *
 * If --verify is appended, also reads each proxy's getProxyImplementation
 * from chain and flags any drift vs the manifest.
 */
import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface Entry {
  name: string;
  address: string;
  implementation?: string;
  note?: string;
  replacedBy?: string;
}

const PROXY_ADMIN_ABI = [
  "function getProxyImplementation(address proxy) view returns (address)",
];

async function main() {
  const net = network.name;
  const filePath = path.resolve(__dirname, "..", "contract-addresses.json");
  const all = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const block = all[net];
  if (!block) {
    throw new Error(`No section for network '${net}' in contract-addresses.json`);
  }

  const active: Entry[] = [];
  const deprecated: Entry[] = [];
  for (const [name, value] of Object.entries<any>(block)) {
    if (name === "_deprecated") {
      for (const [dname, dval] of Object.entries<any>(value)) {
        if (dname.startsWith("_")) continue;
        deprecated.push({
          name: dname,
          address: dval.address ?? "",
          note: dval.note ?? dval._note,
          replacedBy: dval.replacedBy,
        });
      }
    } else if (name.startsWith("_")) {
      continue;
    } else {
      active.push({
        name,
        address: value.address ?? "",
        implementation: value.implementation,
      });
    }
  }

  active.sort((a, b) => a.name.localeCompare(b.name));
  deprecated.sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\nContract addresses on ${net}`);
  console.log(`(source: contract-addresses.json)\n`);

  const verify = process.argv.includes("--verify");
  let admin: any = undefined;
  if (verify) {
    const adminAddr = block.DefaultProxyAdmin?.address;
    if (adminAddr) admin = new ethers.Contract(adminAddr, PROXY_ADMIN_ABI, ethers.provider as any);
  }

  console.log(`ACTIVE (${active.length}):`);
  const nameWidth = Math.max(...active.map((e) => e.name.length), 20);
  for (const e of active) {
    console.log(`  ${e.name.padEnd(nameWidth)}  ${e.address}`);
    if (e.implementation) {
      let flag = "";
      if (verify && admin) {
        try {
          const onChain: string = await admin.getProxyImplementation(e.address);
          if (onChain.toLowerCase() !== e.implementation.toLowerCase()) {
            flag = `  !! drift — on-chain ${onChain}`;
          }
        } catch {
          // not a proxy under this admin
        }
      }
      console.log(`  ${" ".repeat(nameWidth)}  └─ impl ${e.implementation}${flag}`);
    }
  }

  if (deprecated.length > 0) {
    console.log(`\nDEPRECATED (${deprecated.length}):`);
    const dWidth = Math.max(...deprecated.map((e) => e.name.length), 20);
    for (const e of deprecated) {
      console.log(`  ${e.name.padEnd(dWidth)}  ${e.address}`);
      if (e.replacedBy) console.log(`  ${" ".repeat(dWidth)}  └─ replacedBy: ${e.replacedBy}`);
      if (e.note) {
        const wrapped = wrap(e.note, 76);
        for (const line of wrapped) {
          console.log(`  ${" ".repeat(dWidth)}     ${line}`);
        }
      }
    }
  }

  console.log("");
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > width) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
