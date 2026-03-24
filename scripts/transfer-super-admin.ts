/**
 * Transfers ownership and admin roles on ALL deployed contracts to a new "super admin" address.
 *
 * Run:  npx hardhat run scripts/transfer-super-admin.ts --network <network>
 *
 * Required env:
 *   SUPER_ADMIN_ADDRESS  — the new owner/admin EOA
 *   DRY_RUN=1            — (optional) log what would happen without sending transactions
 *   CHECK_ONLY=1         — (optional) only check current ownership/roles, no transfers
 */
import * as readline from "readline";
import { network, ethers } from "hardhat";
import { getContracts } from "./utils";

function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

// ─── Contract definitions ───────────────────────────────────────────────────

interface AccessControlRole {
  name: string;
  hash: string;
}

interface ContractDef {
  name: string;
  /** Key in contract-addresses.json */
  key: string;
  /** Artifact name for getContractAt. Defaults to "OwnableUpgradeable" for ownership-only contracts. */
  artifact?: string;
  /** If set, transfer Ownable ownership. */
  ownable: boolean;
  /** AccessControl roles to grant/revoke. Empty means no role management. */
  roles: AccessControlRole[];
}

const DEFAULT_ADMIN_ROLE = ethers.constants.HashZero;
const OPERATOR = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("OPERATOR"));
const WITHDRAWER = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("WITHDRAWER"));
const DEPOSITOR = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("DEPOSITOR"));

const ALL_CONTRACTS: ContractDef[] = [
  // Ownable-only contracts
  { name: "TimeLockRouter", key: "TimeLockRouter", ownable: true, roles: [] },
  { name: "TimelockERC20", key: "TimelockERC20", ownable: true, roles: [] },
  { name: "TimelockERC721", key: "TimelockERC721", ownable: true, roles: [] },
  { name: "TimelockERC1155", key: "TimelockERC1155", ownable: true, roles: [] },
  { name: "LegacyDeployer", key: "LegacyDeployer", ownable: true, roles: [] },
  { name: "EIP712LegacyVerifier", key: "EIP712LegacyVerifier", ownable: true, roles: [] },
  { name: "PremiumSetting", key: "PremiumSetting", ownable: true, roles: [] },
  { name: "PremiumAutomationManager", key: "PremiumAutomationManager", ownable: true, roles: [] },
  { name: "PremiumMailRouter", key: "PremiumMailRouter", ownable: true, roles: [] },
  { name: "PremiumMailBeforeActivation", key: "PremiumMailBeforeActivation", ownable: true, roles: [] },
  { name: "PremiumMailActivated", key: "PremiumMailActivated", ownable: true, roles: [] },
  { name: "PremiumMailReadyToActivate", key: "PremiumMailReadyToActivate", ownable: true, roles: [] },

  // AccessControl-only contracts
  {
    name: "TokenWhiteList", key: "TokenWhiteList", artifact: "TokenWhiteList", ownable: false,
    roles: [{ name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE }],
  },
  {
    name: "Payment", key: "Payment", artifact: "Payment", ownable: false,
    roles: [
      { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
      { name: "WITHDRAWER", hash: WITHDRAWER },
      { name: "OPERATOR", hash: OPERATOR },
    ],
  },
  {
    name: "Banner", key: "Banner", artifact: "Banner", ownable: false,
    roles: [
      { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
      { name: "OPERATOR", hash: OPERATOR },
    ],
  },

  // Ownable + AccessControl
  {
    name: "PremiumRegistry", key: "PremiumRegistry", artifact: "PremiumRegistry", ownable: true,
    roles: [
      { name: "DEFAULT_ADMIN_ROLE", hash: DEFAULT_ADMIN_ROLE },
      { name: "DEPOSITOR", hash: DEPOSITOR },
      { name: "OPERATOR", hash: OPERATOR },
    ],
  },

  // Proxy admin
  { name: "DefaultProxyAdmin", key: "DefaultProxyAdmin", ownable: true, roles: [] },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

type Result = { contract: string; action: string; status: "success" | "skipped" | "failed"; detail: string };
const results: Result[] = [];

function log(contract: string, action: string, status: Result["status"], detail: string) {
  const icon = status === "success" ? "✓" : status === "skipped" ? "–" : "✗";
  console.log(`  ${icon} [${contract}] ${action}: ${detail}`);
  results.push({ contract, action, status, detail });
}

type ContractMap = Record<string, { address: string; implementation?: string }>;

async function checkOwnership(name: string, address: string, target: string): Promise<boolean> {
  try {
    const contract = await ethers.getContractAt("OwnableUpgradeable", address);
    const owner: string = await contract.owner();
    const isTarget = owner.toLowerCase() === target.toLowerCase();
    const icon = isTarget ? "✓" : "✗";
    console.log(`  ${icon} [${name}] owner: ${owner}${isTarget ? "" : " (NOT target)"}`);
    return isTarget;
  } catch (err: unknown) {
    console.log(`  ✗ [${name}] error: ${(err as Error).message}`);
    return false;
  }
}

async function checkRole(name: string, contract: any, role: AccessControlRole, target: string): Promise<boolean> {
  try {
    const has: boolean = await contract.hasRole(role.hash, target);
    const icon = has ? "✓" : "✗";
    console.log(`  ${icon} [${name}] ${role.name}: ${has ? "YES" : "NO"}`);
    return has;
  } catch (err: unknown) {
    console.log(`  ✗ [${name}] ${role.name} error: ${(err as Error).message}`);
    return false;
  }
}

async function transferOwnership(
  name: string, address: string, newAdmin: string, signerAddress: string, dryRun: boolean,
) {
  try {
    const contract = await ethers.getContractAt("OwnableUpgradeable", address);
    const currentOwner: string = await contract.owner();

    if (currentOwner.toLowerCase() === newAdmin.toLowerCase()) {
      log(name, "transferOwnership", "skipped", "already owned by new admin");
      return;
    }
    if (currentOwner.toLowerCase() !== signerAddress.toLowerCase()) {
      log(name, "transferOwnership", "failed", `current owner is ${currentOwner}, not signer`);
      return;
    }
    if (dryRun) {
      log(name, "transferOwnership", "skipped", `dry-run: would transfer from ${currentOwner}`);
    } else {
      const tx = await contract.transferOwnership(newAdmin);
      await tx.wait();
      log(name, "transferOwnership", "success", `tx: ${tx.hash}`);
    }
  } catch (err: unknown) {
    log(name, "transferOwnership", "failed", (err as Error).message);
  }
}

async function transferRole(
  name: string, contract: any, role: AccessControlRole,
  newAdmin: string, dryRun: boolean,
) {
  try {
    const alreadyHasRole: boolean = await contract.hasRole(role.hash, newAdmin);
    if (alreadyHasRole) {
      log(name, `grantRole(${role.name})`, "skipped", "new admin already has role");
    } else if (dryRun) {
      log(name, `grantRole(${role.name})`, "skipped", "dry-run: would grant");
    } else {
      const tx = await contract.grantRole(role.hash, newAdmin);
      await tx.wait();
      log(name, `grantRole(${role.name})`, "success", `tx: ${tx.hash}`);
    }
  } catch (err: unknown) {
    log(name, `grantRole(${role.name})`, "failed", (err as Error).message);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const newAdmin = process.env.SUPER_ADMIN_ADDRESS;
  if (!newAdmin || !ethers.utils.isAddress(newAdmin)) {
    throw new Error("Set SUPER_ADMIN_ADDRESS in env to a valid Ethereum address");
  }
  const dryRun = process.env.DRY_RUN === "1";
  const checkOnly = process.env.CHECK_ONLY === "1";

  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();

  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contract addresses found for network "${network.name}"`);

  console.log(`\nNetwork:     ${network.name}`);
  console.log(`Target:      ${newAdmin}`);
  if (checkOnly) {
    console.log(`Mode:        CHECK ONLY (read-only)\n`);
  } else {
    console.log(`Signer:      ${signerAddress}`);
    console.log(`Dry run:     ${dryRun}\n`);
  }

  if (checkOnly) {
    let allOk = true;
    for (const def of ALL_CONTRACTS) {
      const entry = contracts[def.key];
      if (!entry) { console.log(`  – [${def.name}] not deployed`); continue; }
      if (def.ownable) {
        if (!await checkOwnership(def.name, entry.address, newAdmin)) allOk = false;
      }
      if (def.roles.length > 0) {
        const contract = await ethers.getContractAt(def.artifact ?? def.name, entry.address);
        for (const role of def.roles) {
          if (!await checkRole(def.name, contract, role, newAdmin)) allOk = false;
        }
      }
    }
    console.log(`\n=== Result: ${allOk ? "ALL OK" : "INCOMPLETE — see ✗ items above"} ===\n`);
    return;
  }

  if (!dryRun) {
    const ok = await confirm(
      `⚠️  This will transfer ownership of all contracts on ${network.name} to ${newAdmin}.\n` +
      `   Continue? (y/N) `
    );
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  for (const def of ALL_CONTRACTS) {
    const entry = contracts[def.key];
    if (!entry) {
      log(def.name, "transfer", "skipped", "not deployed on this network");
      continue;
    }
    if (def.ownable) {
      await transferOwnership(def.name, entry.address, newAdmin, signerAddress, dryRun);
    }
    if (def.roles.length > 0) {
      const contract = await ethers.getContractAt(def.artifact ?? def.name, entry.address);
      for (const role of def.roles) {
        await transferRole(def.name, contract, role, newAdmin, dryRun);
      }
    }
  }

  // ── Summary ──

  console.log("\n=== Summary ===\n");
  const succeeded = results.filter((r) => r.status === "success").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const failed = results.filter((r) => r.status === "failed").length;
  console.log(`  Success: ${succeeded}  |  Skipped: ${skipped}  |  Failed: ${failed}`);

  if (failed > 0) {
    console.log("\nFailed operations:");
    for (const r of results.filter((r) => r.status === "failed")) {
      console.log(`  ✗ ${r.contract} — ${r.action}: ${r.detail}`);
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
