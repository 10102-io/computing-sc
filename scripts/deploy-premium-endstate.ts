import { ethers } from "hardhat";
import * as hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getContracts, saveContract, shouldVerify, verifyProxyOnEtherscan } from "./utils";

/**
 * Phase B END-STATE deploy/upgrade — single bundled release (lean cutover).
 *
 * Does four things, in order:
 *   1. Upgrade PremiumRegistry impl   (B-1: SafeERC20 fix)
 *   2. Upgrade PremiumSetting impl     (end-state: Chainlink teardown, M-2' fix,
 *                                       emit-only triggers, PII-free setters/events,
 *                                       custom errors)
 *   3. Deploy PremiumReminderView      (standalone read-only "due" view the
 *                                       reminder-worker polls)
 *   4. Deploy TransferEOALegacy impl + repoint router.setLegacyImplementation
 *                                      (dead-code-stripped lean clone target; new
 *                                       legacies clone the lean impl, existing
 *                                       legacies are unaffected)
 *
 * Every proxy upgrade also REFRESHES deployments/<network>/<Name>_Implementation.json
 * (.abi/.address/.bytecode) so scripts/sync-ui.ts always reads the ABI of what is
 * actually deployed — never a stale pre-upgrade ABI.
 *
 * Run on Sepolia FIRST, point the worker at it, prove emails end-to-end, THEN
 * run on mainnet. Chainlink upkeep/Functions teardown (cancel upkeeps / withdraw
 * LINK / Functions sub) is a separate manual step at cutover.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-premium-endstate.ts --network sepolia
 *   npx hardhat run scripts/deploy-premium-endstate.ts --network mainnet
 *
 * Requires:
 *   - DEPLOYER_PRIVATE_KEY (or the Sepolia deployer key) in .env
 *   - The deployer must own DefaultProxyAdmin (steps 1-2) and be the EOA router
 *     codeAdmin (step 4)
 *   - contract-addresses.json populated for the network
 *
 * Optional env:
 *   - DEFAULT_NOTIFY_AHEAD  — seconds; fallback for the view if the legacy
 *     PremiumAutomationManager.defaultNotifyAhead() can't be read (default 604800 = 7d)
 *   - ONLY=registry|setting|view|eoa  — run just one step (comma-separated allowed)
 */

const PROXY_ADMIN_ABI = [
  "function owner() view returns (address)",
  "function getProxyImplementation(address) view returns (address)",
  "function upgrade(address,address)"
];

type Steps = { registry: boolean; setting: boolean; view: boolean; eoa: boolean };

function parseSteps(): Steps {
  const only = (process.env.ONLY ?? "").trim().toLowerCase();
  if (!only) return { registry: true, setting: true, view: true, eoa: true };
  const set = new Set(only.split(",").map((s) => s.trim()));
  return {
    registry: set.has("registry"),
    setting: set.has("setting"),
    view: set.has("view"),
    eoa: set.has("eoa"),
  };
}

/**
 * Refresh deployments/<network>/<Name>_Implementation.json so its ABI/address
 * match the freshly compiled + deployed implementation. scripts/sync-ui.ts reads
 * the ABI from these artifacts; without this they keep the previous impl's ABI.
 * Preserves any other fields already present in the artifact.
 */
async function refreshImplArtifact(network: string, name: string, implAddress: string): Promise<void> {
  try {
    const artifact = await hre.artifacts.readArtifact(name);
    const dir = path.join(process.cwd(), "deployments", network);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}_Implementation.json`);
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    existing.address = implAddress;
    existing.abi = artifact.abi;
    existing.bytecode = artifact.bytecode;
    existing.deployedBytecode = artifact.deployedBytecode;
    fs.writeFileSync(file, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    console.log(`  deployments/${network}/${name}_Implementation.json refreshed (ABI matches deploy).`);
  } catch (e: any) {
    console.warn(`  Could not refresh deployment artifact for ${name}:`, e?.message ?? e);
  }
}

async function verifyImpl(address: string, constructorArguments: unknown[]): Promise<void> {
  if (!shouldVerify(hre.network.name)) return;
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log("  Etherscan source verification complete.");
  } catch (e: any) {
    if (e.message?.includes("Already Verified")) console.log("  Already verified on Etherscan.");
    else console.warn("  Etherscan verification failed:", e.message ?? e);
  }
}

async function linkProxy(proxyAddr: string, implAddr: string): Promise<void> {
  if (!shouldVerify(hre.network.name)) return;
  const apiKey = process.env.API_KEY_ETHERSCAN;
  const chainId = hre.network.config?.chainId;
  if (!apiKey || chainId == null) return;
  try {
    const result = await verifyProxyOnEtherscan(proxyAddr, implAddr, chainId, apiKey);
    console.log(result.success ? `  Etherscan proxy link: ${result.message}` : `  Proxy verify: ${result.message}`);
  } catch (e) {
    console.warn("  Etherscan proxy verification failed:", e);
  }
}

async function upgradeProxy(
  name: string,
  proxyAdmin: any,
  proxyAddr: string,
  network: string
): Promise<string> {
  console.log(`\n── Upgrading ${name} ──`);
  const currentImpl: string = await proxyAdmin.getProxyImplementation(proxyAddr);
  console.log(`  Proxy:           ${proxyAddr}`);
  console.log(`  Current impl:    ${currentImpl}`);

  const Factory = await ethers.getContractFactory(name);
  const newImpl = await Factory.deploy();
  await newImpl.deployed();
  console.log(`  New impl:        ${newImpl.address}`);

  if (currentImpl.toLowerCase() === newImpl.address.toLowerCase()) {
    console.log("  Bytecode unchanged — skipping upgrade.");
    return currentImpl;
  }

  const tx = await proxyAdmin.upgrade(proxyAddr, newImpl.address);
  console.log(`  Upgrade tx:      ${tx.hash}`);
  await tx.wait(1);

  const verified: string = await proxyAdmin.getProxyImplementation(proxyAddr);
  console.log(`  Confirmed impl:  ${verified}`);
  saveContract(network, name, proxyAddr, newImpl.address);
  console.log("  contract-addresses.json updated.");
  await refreshImplArtifact(network, name, newImpl.address);

  await verifyImpl(newImpl.address, []);
  await linkProxy(proxyAddr, newImpl.address);
  return verified;
}

const EOA_ROUTER_ABI = [
  "function legacyImplementation() view returns (address)",
  "function setLegacyImplementation(address)",
];

/**
 * Deploy the dead-code-stripped TransferEOALegacy clone implementation and
 * repoint the EOA router at it via setLegacyImplementation (onlyCodeAdmin).
 * Existing legacies are unaffected (impl is baked into their clone bytecode);
 * only future createLegacy calls clone the lean impl.
 */
async function deployEoaImplAndRepoint(network: string, routerAddr: string): Promise<string> {
  console.log(`\n── Deploying TransferEOALegacy impl + repointing EOA router ──`);
  const router = await ethers.getContractAt(EOA_ROUTER_ABI, routerAddr);
  const currentImpl: string = await router.legacyImplementation();
  console.log(`  EOA router:          ${routerAddr}`);
  console.log(`  Current legacy impl: ${currentImpl}`);

  const Factory = await ethers.getContractFactory("TransferEOALegacy");
  const impl = await Factory.deploy();
  await impl.deployed();
  console.log(`  New legacy impl:     ${impl.address}`);

  // Pre-flight: setLegacyImplementation is onlyCodeAdmin. callStatic surfaces a
  // NotCodeAdmin revert here (before spending gas) if the deployer is not codeAdmin.
  try {
    await router.callStatic.setLegacyImplementation(impl.address);
  } catch (e: any) {
    throw new Error(
      `EOA router repoint pre-flight failed (deployer likely not codeAdmin): ${e?.message ?? e}`
    );
  }

  const tx = await router.setLegacyImplementation(impl.address);
  console.log(`  Repoint tx:          ${tx.hash}`);
  await tx.wait(1);
  const confirmed: string = await router.legacyImplementation();
  console.log(`  Confirmed impl:      ${confirmed}`);
  if (confirmed.toLowerCase() !== impl.address.toLowerCase()) {
    throw new Error(`Repoint mismatch: router reports ${confirmed}, expected ${impl.address}`);
  }

  saveContract(network, "TransferEOALegacyImpl", impl.address);
  console.log("  contract-addresses.json updated (TransferEOALegacyImpl).");

  await verifyImpl(impl.address, []);
  return impl.address;
}

async function deployReminderView(
  settingAddr: string,
  managerAddr: string | undefined,
  network: string
): Promise<string> {
  console.log(`\n── Deploying PremiumReminderView ──`);

  // An explicit DEFAULT_NOTIFY_AHEAD always wins. Otherwise mirror the legacy
  // manager's value so reminder timing is unchanged; final fallback is 7 days.
  let defaultNotifyAhead = Number(process.env.DEFAULT_NOTIFY_AHEAD ?? 0);
  const envOverride = defaultNotifyAhead > 0;
  if (envOverride) {
    console.log(`  defaultNotifyAhead from DEFAULT_NOTIFY_AHEAD override: ${defaultNotifyAhead}s`);
  } else if (managerAddr) {
    try {
      const mgr = await ethers.getContractAt(["function defaultNotifyAhead() view returns (uint256)"], managerAddr);
      const onchain = await mgr.defaultNotifyAhead();
      if (onchain && Number(onchain) > 0) {
        defaultNotifyAhead = Number(onchain);
        console.log(`  defaultNotifyAhead from PremiumAutomationManager: ${defaultNotifyAhead}s`);
      }
    } catch {
      console.log("  Could not read PremiumAutomationManager.defaultNotifyAhead(); using fallback.");
    }
  }
  if (!defaultNotifyAhead || defaultNotifyAhead <= 0) {
    defaultNotifyAhead = 604800; // 7 days
    console.log(`  Using fallback defaultNotifyAhead: ${defaultNotifyAhead}s (set DEFAULT_NOTIFY_AHEAD to override)`);
  }

  console.log(`  PremiumSetting:  ${settingAddr}`);
  const Factory = await ethers.getContractFactory("PremiumReminderView");
  const view = await Factory.deploy(settingAddr, defaultNotifyAhead);
  await view.deployed();
  console.log(`  Deployed:        ${view.address}`);

  saveContract(network, "PremiumReminderView", view.address);
  console.log("  contract-addresses.json updated.");

  await verifyImpl(view.address, [settingAddr, defaultNotifyAhead]);
  return view.address;
}

async function main() {
  const network = hre.network.name;
  const steps = parseSteps();
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Steps:    registry=${steps.registry} setting=${steps.setting} view=${steps.view} eoa=${steps.eoa}`);

  const networkContracts = getContracts()[network];
  if (!networkContracts) throw new Error(`No contract addresses for network "${network}"`);

  const proxyAdminAddr = networkContracts["DefaultProxyAdmin"]?.address;
  const registryAddr = networkContracts["PremiumRegistry"]?.address;
  const settingAddr = networkContracts["PremiumSetting"]?.address;
  const managerAddr = networkContracts["PremiumAutomationManager"]?.address;
  const eoaRouterAddr = networkContracts["TransferEOALegacyRouter"]?.address;
  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!settingAddr) throw new Error("PremiumSetting proxy address not found");

  const proxyAdmin = await ethers.getContractAt(PROXY_ADMIN_ABI, proxyAdminAddr);
  const adminOwner: string = await proxyAdmin.owner();
  if (adminOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer ${deployer.address} is not the ProxyAdmin owner (${adminOwner}). Use the correct key.`);
  }
  console.log(`Proxy admin: ${proxyAdminAddr} (owner OK)`);

  const summary: Record<string, string> = {};

  if (steps.registry) {
    if (!registryAddr) throw new Error("PremiumRegistry proxy address not found");
    summary.PremiumRegistry = await upgradeProxy("PremiumRegistry", proxyAdmin, registryAddr, network);
  }
  if (steps.setting) {
    summary.PremiumSetting = await upgradeProxy("PremiumSetting", proxyAdmin, settingAddr, network);
  }
  if (steps.view) {
    summary.PremiumReminderView = await deployReminderView(settingAddr, managerAddr, network);
  }
  if (steps.eoa) {
    if (!eoaRouterAddr) throw new Error("TransferEOALegacyRouter proxy address not found");
    summary.TransferEOALegacyImpl = await deployEoaImplAndRepoint(network, eoaRouterAddr);
  }

  console.log("\n══════════════════════════════════════════");
  console.log("END-STATE DEPLOY SUMMARY");
  for (const [k, v] of Object.entries(summary)) console.log(`  ${k}: ${v}`);
  if (summary.PremiumReminderView) {
    console.log("\nWorker env to set:");
    console.log(`  REMINDER_VIEW_ADDRESS=${summary.PremiumReminderView}`);
    console.log(`  CHAIN_ID=${hre.network.config?.chainId ?? "(set manually)"}`);
  }
  console.log("══════════════════════════════════════════");
  console.log("\nNext: point the worker at these, run a Sepolia end-to-end email test,");
  console.log("then repeat on mainnet and do the Chainlink teardown.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
