import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Walk every entry in contract-addresses.json → sepolia and confirm the signer is in
// full admin control (owner and/or DEFAULT_ADMIN_ROLE). Meant as a final gate before
// declaring the Sepolia ecosystem healthy.

const EXPECTED_ADMIN = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";

type Entry = { address: string; implementation?: string };
type NetworkMap = Record<string, Entry | Record<string, unknown>>;

interface Result {
  name: string;
  address: string;
  ownerOk: boolean | null;
  roleOk: boolean | null;
  note?: string;
}

async function probe(name: string, addr: string): Promise<Result> {
  const r: Result = { name, address: addr, ownerOk: null, roleOk: null };
  try {
    const o = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      addr
    );
    const owner = (await (o as any).owner()).toLowerCase();
    r.ownerOk = owner === EXPECTED_ADMIN.toLowerCase();
    if (!r.ownerOk) r.note = `owner=${owner}`;
  } catch {
    // no Ownable
  }
  try {
    const c = await ethers.getContractAt(
      [
        "function hasRole(bytes32,address) view returns (bool)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      ],
      addr
    );
    const role = await (c as any).DEFAULT_ADMIN_ROLE();
    r.roleOk = await (c as any).hasRole(role, EXPECTED_ADMIN);
  } catch {
    // no AccessControl
  }
  return r;
}

function isActiveEntry(name: string): boolean {
  return !name.startsWith("_") && !name.endsWith("_orphaned") && !name.endsWith("_redeployed_unused");
}

async function main() {
  const [s] = await ethers.getSigners();
  console.log(`Signer: ${await s.getAddress()}`);
  console.log(`Expected admin: ${EXPECTED_ADMIN}`);
  console.log("");

  const file = path.join(__dirname, "..", "contract-addresses.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  const sepolia = parsed.sepolia as NetworkMap;

  const entries: Array<[string, Entry]> = [];
  for (const [name, value] of Object.entries(sepolia)) {
    if (!isActiveEntry(name)) continue;
    const v = value as Entry;
    if (typeof v?.address === "string") entries.push([name, v]);
  }

  const results: Result[] = [];
  for (const [name, entry] of entries) {
    const r = await probe(name, entry.address);
    results.push(r);
    const owner = r.ownerOk === null ? "  -  " : r.ownerOk ? "  ✓  " : "  ✗  ";
    const role = r.roleOk === null ? "  -  " : r.roleOk ? "  ✓  " : "  ✗  ";
    const controlled = r.ownerOk === true || r.roleOk === true;
    const controlPart = r.ownerOk === null && r.roleOk === null ? "n/a (stateless?)" : "";
    const tag = controlled ? " " : r.ownerOk === null && r.roleOk === null ? " " : " ⚠";
    console.log(
      `${tag} ${name.padEnd(32)} owner${owner} role${role} ${entry.address} ${controlPart}`
    );
  }

  console.log("\nSummary:");
  const problems = results.filter(
    (r) => (r.ownerOk === false && r.roleOk !== true) || (r.roleOk === false && r.ownerOk !== true)
  );
  if (problems.length === 0) {
    console.log("  All active contracts are under YOUR control (owner or DEFAULT_ADMIN_ROLE).");
  } else {
    console.log("  Problems:");
    for (const p of problems) {
      console.log(`    - ${p.name} ${p.address} owner=${p.ownerOk} role=${p.roleOk} ${p.note ?? ""}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
