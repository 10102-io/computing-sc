/**
 * Redeploy the 4 "orphaned" Sepolia contracts with YOU as admin/owner.
 *
 * Context:
 *   The original Sepolia deployer (0x9747...886f, previous dev) either renounced
 *   DEFAULT_ADMIN_ROLE on these contracts or never granted it to the current admin.
 *   scripts/diagnose-sepolia-orphans.ts confirms nobody holds admin on:
 *     - TokenWhiteList
 *     - Payment
 *     - Banner
 *     - PremiumRegistry
 *
 * What this script does:
 *   1. Verifies network == sepolia AND signer == EXPECTED_ADMIN (0xfe8b...b630).
 *   2. Moves the 4 old deployment artifacts to _orphan-<Name>.json backups so
 *      hardhat-deploy will deploy fresh instead of reusing cached bytecode.
 *   3. Records the old addresses in contract-addresses.json under _orphaned_<Name>
 *      keys (so we never lose the historical reference).
 *   4. Runs the 4 deploy tags (Payment -> TokenWhiteList -> PremiumRegistry -> Banner).
 *      hardhat-deploy updates contract-addresses.json automatically via saveContract.
 *   5. Prints a summary of old -> new addresses.
 *
 * What this script does NOT do:
 *   - Rewire TimeLockRouter / PremiumSetting (separate step: rewire-sepolia-orphans.ts)
 *   - Re-whitelist ERC-20s (separate step)
 *   - Redeploy the 10102-contracts-sepolia subgraph (separate repo)
 *
 * Safety:
 *   - DRY_RUN=1 (default): prints plan, makes no on-chain or FS changes.
 *   - DRY_RUN=0: actually executes.
 *
 * Run:
 *   DRY_RUN=1 npx hardhat run scripts/redeploy-sepolia-orphans.ts --network sepolia
 *   DRY_RUN=0 npx hardhat run scripts/redeploy-sepolia-orphans.ts --network sepolia
 */
import * as fs from "fs";
import * as path from "path";
import hre, { ethers, network } from "hardhat";
import { getContracts } from "./utils";

const EXPECTED_ADMIN = (process.env.EXPECTED_ADMIN ?? "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630").trim();

// Order matters: PremiumRegistry depends on Payment being freshly deployed.
const ORPHAN_NAMES = ["Payment", "TokenWhiteList", "PremiumRegistry", "Banner"] as const;
type OrphanName = (typeof ORPHAN_NAMES)[number];

async function main() {
  const dryRun = process.env.DRY_RUN !== "0";

  if (network.name !== "sepolia") {
    throw new Error(`This script only runs on sepolia. Current: ${network.name}`);
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network:       ${network.name}`);
  console.log(`Signer:        ${deployer.address}`);
  console.log(`Expected:      ${EXPECTED_ADMIN}`);
  console.log(`Mode:          ${dryRun ? "DRY RUN (no changes)" : "EXECUTE"}`);

  if (deployer.address.toLowerCase() !== EXPECTED_ADMIN.toLowerCase()) {
    throw new Error(
      `Signer ${deployer.address} != EXPECTED_ADMIN ${EXPECTED_ADMIN}. ` +
      `Refusing to deploy with the wrong key. Override EXPECTED_ADMIN env if intentional.`
    );
  }

  const deploymentsDir = path.join(process.cwd(), "deployments", "sepolia");
  const contractAddressesPath = path.join(process.cwd(), "contract-addresses.json");
  const currentContracts = getContracts();

  // Step 1: record old addresses. Prefer the _orphan-*.json backup if it exists
  // (handles reruns after partial failures where we must not confuse the new address
  // for the orphan one).
  const oldAddrs: Record<OrphanName, string> = {
    Payment: "",
    TokenWhiteList: "",
    PremiumRegistry: "",
    Banner: "",
  };
  for (const name of ORPHAN_NAMES) {
    const backupPath = path.join(deploymentsDir, `_orphan-${name}.json`);
    const artifactPath = path.join(deploymentsDir, `${name}.json`);
    const sourcePath = fs.existsSync(backupPath) ? backupPath : artifactPath;
    if (fs.existsSync(sourcePath)) {
      const data = JSON.parse(fs.readFileSync(sourcePath, "utf-8"));
      oldAddrs[name] = data.address;
    } else {
      const existingOrphanEntry = currentContracts.sepolia?.[`_orphaned_${name}`]?.address;
      oldAddrs[name] = existingOrphanEntry ?? currentContracts.sepolia?.[name]?.address ?? "(unknown)";
    }
  }

  console.log("\n─".repeat(72));
  console.log("Orphan addresses (will be recorded as _orphaned_<Name>):");
  for (const name of ORPHAN_NAMES) {
    console.log(`  ${name.padEnd(16)} ${oldAddrs[name]}`);
  }

  if (dryRun) {
    console.log("\nPlan:");
    console.log(`  1. Move ${ORPHAN_NAMES.map(n => `${n}.json`).join(", ")} -> _orphan-<Name>.json`);
    console.log("  2. Record old addresses under sepolia._orphaned_<Name> in contract-addresses.json");
    console.log("  3. Run deploy tags: Payment, TokenWhiteList, PremiumRegistry, Banner");
    console.log("  4. Print old -> new summary");
    console.log("\n(dry run — no changes made)\n");
    console.log("Re-run with DRY_RUN=0 to execute.\n");
    return;
  }

  // Step 2: back up orphan artifacts (main + proxy/impl siblings for upgradeable ones).
  // hardhat-deploy caches by artifact presence: if we miss the _Implementation/_Proxy
  // variants, the rerun will "succeed" but still point at the old orphan proxy.
  console.log("\nStep 1: Backing up orphan deployment artifacts...");
  const artifactSuffixes = ["", "_Implementation", "_Proxy"];
  for (const name of ORPHAN_NAMES) {
    for (const suffix of artifactSuffixes) {
      const fileName = `${name}${suffix}.json`;
      const artifactPath = path.join(deploymentsDir, fileName);
      const backupPath = path.join(deploymentsDir, `_orphan-${fileName}`);
      if (fs.existsSync(artifactPath)) {
        if (fs.existsSync(backupPath)) {
          // keep the existing backup; remove the live one so the next deploy is forced
          fs.unlinkSync(artifactPath);
          console.log(`  ${fileName}: backup exists, removed live copy`);
        } else {
          fs.renameSync(artifactPath, backupPath);
          console.log(`  ${fileName} -> _orphan-${fileName}`);
        }
      }
    }
  }

  // Step 3: record old addresses in contract-addresses.json as _orphaned_<Name>
  // (skip if already present — preserves the original orphan address across reruns).
  console.log("\nStep 2: Recording orphan addresses in contract-addresses.json...");
  const data = JSON.parse(fs.readFileSync(contractAddressesPath, "utf-8"));
  if (!data.sepolia) data.sepolia = {};
  for (const name of ORPHAN_NAMES) {
    const key = `_orphaned_${name}`;
    if (data.sepolia[key]) {
      console.log(`  ${key}: already present (${data.sepolia[key].address}) — keeping.`);
    } else {
      data.sepolia[key] = { address: oldAddrs[name] };
      console.log(`  ${key}: recorded ${oldAddrs[name]}`);
    }
  }
  fs.writeFileSync(contractAddressesPath, JSON.stringify(data, null, 2), "utf-8");

  // Step 4: run the 4 deploys with pauses to avoid Sepolia mempool nonce collisions
  // (REPLACEMENT_UNDERPRICED happens when the next run submits before the previous
  // tx has propagated far enough for the RPC's nonce view to advance).
  console.log("\nStep 3: Running deploy tags (Payment -> TokenWhiteList -> PremiumRegistry -> Banner)...");
  console.log("        This mints on-chain transactions. Each may take ~15-60s on Sepolia.\n");

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const INTER_DEPLOY_PAUSE_MS = 10_000;

  // Payment has no dependencies.
  await hre.deployments.run(["Payment"]);
  await sleep(INTER_DEPLOY_PAUSE_MS);
  // TokenWhiteList has only TestERC20 as dep (already deployed).
  await hre.deployments.run(["TokenWhiteList"]);
  await sleep(INTER_DEPLOY_PAUSE_MS);
  // PremiumRegistry depends on PremiumSetting (existing) + Payment (just redeployed).
  await hre.deployments.run(["PremiumRegistry"]);
  await sleep(INTER_DEPLOY_PAUSE_MS);
  // Banner standalone.
  await hre.deployments.run(["Banner"]);

  // Step 5: summary
  const updated = getContracts();
  console.log("\n" + "─".repeat(72));
  console.log("Redeployment complete. Old -> New:\n");
  for (const name of ORPHAN_NAMES) {
    const newAddr = updated.sepolia?.[name]?.address ?? "(missing)";
    const same = newAddr === oldAddrs[name];
    const marker = same ? "  ⚠ UNCHANGED (likely cached — investigate)" : "  ✓";
    console.log(`  ${name.padEnd(16)} ${oldAddrs[name]}`);
    console.log(`  ${" ".repeat(16)} -> ${newAddr}${marker}`);
  }

  console.log("\nNext steps:");
  console.log("  1. scripts/rewire-sepolia-orphans.ts (TimeLockRouter.setTokenWhitelist + PremiumSetting.setParams)");
  console.log("  2. Re-whitelist ERC-20s on new TokenWhiteList (WETH, wstETH, test USDC/USDT)");
  console.log("  3. Seed penny plan in new PremiumRegistry");
  console.log("  4. Update computing-subgraph/networks.json + redeploy 10102-contracts-sepolia");
  console.log("  5. npm run sync-ui (pushes new addresses into frontend)");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
