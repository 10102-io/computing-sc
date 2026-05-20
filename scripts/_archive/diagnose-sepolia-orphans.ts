/**
 * Diagnose Sepolia "orphaned contracts" situation.
 *
 * Reads on-chain admin state for every contract in contract-addresses.json[sepolia]
 * and reports:
 *   - For Ownable contracts: current owner()
 *   - For AccessControl contracts: hasRole(DEFAULT_ADMIN_ROLE, <each candidate>)
 *   - For the 4 reportedly-orphaned contracts: expanded role check (OPERATOR, WITHDRAWER, DEPOSITOR)
 *   - DefaultProxyAdmin.owner() (critical: governs future proxy upgrades)
 *
 * This is a READ-ONLY script. It does not send any transactions.
 *
 * Run: npx hardhat run scripts/diagnose-sepolia-orphans.ts --network sepolia
 *
 * Optional env:
 *   EXPECTED_ADMIN=0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630  (your Sepolia admin wallet)
 *   OLD_DEV=0x974763b760d566154B1767534cF9537CEe2f886f         (previous dev's wallet; all Sepolia deploys came from it)
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero;
const OPERATOR = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("OPERATOR"));
const WITHDRAWER = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WITHDRAWER"));
const DEPOSITOR = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DEPOSITOR"));
const ZERO = ethers.constants.AddressZero;

// Orphaned-according-to-previous-dev. Expanded check.
const ORPHAN_KEYS = new Set(["TokenWhiteList", "Payment", "Banner", "PremiumRegistry"]);

interface ContractCheck {
  key: string;
  ownable: boolean;
  ac: boolean;
  roles: { name: string; hash: string }[];
}

// Every contract we want to know the admin state of, in order.
const CHECKS: ContractCheck[] = [
  // Reported orphans
  { key: "TokenWhiteList", ownable: false, ac: true, roles: [{ name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE }] },
  { key: "Payment", ownable: false, ac: true, roles: [
    { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
    { name: "WITHDRAWER", hash: WITHDRAWER },
    { name: "OPERATOR", hash: OPERATOR },
  ] },
  { key: "Banner", ownable: false, ac: true, roles: [
    { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
    { name: "OPERATOR", hash: OPERATOR },
  ] },
  { key: "PremiumRegistry", ownable: true, ac: true, roles: [
    { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
    { name: "OPERATOR", hash: OPERATOR },
    { name: "DEPOSITOR", hash: DEPOSITOR },
  ] },

  // Rewire points: we MUST own these for the redeploy plan to work
  { key: "TimeLockRouter", ownable: true, ac: false, roles: [] },
  { key: "PremiumSetting", ownable: true, ac: false, roles: [] },
  { key: "DefaultProxyAdmin", ownable: true, ac: false, roles: [] },

  // NOTE: Transfer*Router / MultisigLegacyRouter are stateless (no owner/admin).
  // Upgrades are governed via DefaultProxyAdmin above, which we already check.
  { key: "LegacyDeployer", ownable: true, ac: false, roles: [] },
  { key: "EIP712LegacyVerifier", ownable: true, ac: false, roles: [] },
];

async function ownerOf(address: string): Promise<string | null> {
  try {
    const c = await ethers.getContractAt("OwnableUpgradeable", address);
    return (await c.owner()) as string;
  } catch {
    return null;
  }
}

async function hasRole(artifact: string, address: string, role: string, account: string): Promise<boolean | null> {
  try {
    const c = await ethers.getContractAt(artifact, address);
    return (await c.hasRole(role, account)) as boolean;
  } catch {
    return null;
  }
}

function label(addr: string, expected: string, oldDev: string): string {
  if (!addr) return "(null)";
  const a = addr.toLowerCase();
  if (a === expected.toLowerCase()) return `YOU (${short(addr)})`;
  if (a === oldDev.toLowerCase()) return `OLD_DEV (${short(addr)})`;
  if (a === ZERO.toLowerCase()) return `ZERO_ADDR (orphaned)`;
  return `UNKNOWN (${short(addr)})`;
}

function short(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error(`This script only makes sense on sepolia. Current: ${network.name}`);
  }

  const expected = (process.env.EXPECTED_ADMIN ?? "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630").trim();
  const oldDev = (process.env.OLD_DEV ?? "0x974763b760d566154B1767534cF9537CEe2f886f").trim();
  if (!ethers.utils.isAddress(expected)) throw new Error("EXPECTED_ADMIN invalid");
  if (!ethers.utils.isAddress(oldDev)) throw new Error("OLD_DEV invalid");

  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contract-addresses for ${network.name}`);

  console.log(`\nNetwork:      ${network.name}`);
  console.log(`Expected:     ${expected} (should own everything)`);
  console.log(`Old dev:      ${oldDev} (original Sepolia deployer)`);
  console.log(`Zero addr:    ${ZERO} (true orphan indicator)\n`);

  const problems: string[] = [];

  for (const def of CHECKS) {
    const entry = contracts[def.key];
    if (!entry) { console.log(`-- [${def.key}] not in contract-addresses.json`); continue; }

    const orphanMarker = ORPHAN_KEYS.has(def.key) ? " ⚠" : "";
    console.log(`=== ${def.key}${orphanMarker} (${entry.address}) ===`);

    if (def.ownable) {
      const owner = await ownerOf(entry.address);
      if (owner === null) {
        console.log(`  owner():              error reading`);
        problems.push(`${def.key}: owner() unreadable`);
      } else {
        console.log(`  owner():              ${label(owner, expected, oldDev)}`);
        if (owner.toLowerCase() !== expected.toLowerCase()) {
          problems.push(`${def.key}: owner is ${owner}, not ${expected}`);
        }
      }
    }

    if (def.ac) {
      for (const role of def.roles) {
        const meHas = await hasRole(def.key, entry.address, role.hash, expected);
        const oldHas = await hasRole(def.key, entry.address, role.hash, oldDev);
        const meIcon = meHas === true ? "✓" : meHas === false ? "✗" : "?";
        const oldIcon = oldHas === true ? "✓" : oldHas === false ? "✗" : "?";
        console.log(`  hasRole(${role.name.padEnd(18)}): you=${meIcon}  oldDev=${oldIcon}`);
        if (meHas !== true) {
          problems.push(`${def.key}: you do NOT have ${role.name}`);
        }
      }
    }
    console.log("");
  }

  console.log("─".repeat(72));
  if (problems.length === 0) {
    console.log("✓ ALL GREEN — your wallet controls every contract. No orphan contamination.");
    console.log("  (But recheck the 4 reported orphans: if 'you=✗' above for DEFAULT_ADMIN_ROLE, that confirms the orphan.)");
  } else {
    console.log(`Found ${problems.length} issue(s):\n`);
    for (const p of problems) console.log(`  - ${p}`);
    console.log("\nInterpretation guide:");
    console.log("  - Issues ONLY on TokenWhiteList / Payment / Banner / PremiumRegistry → matches dev's report, plan proceeds as designed.");
    console.log("  - Issue on TimeLockRouter / PremiumSetting / DefaultProxyAdmin → BLOCKER. Redeploy plan does not work as-is.");
    console.log("  - Issue on any TransferLegacy*Router / MultisigLegacyRouter → scope has grown; discuss before proceeding.");
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
