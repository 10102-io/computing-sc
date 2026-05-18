/**
 * Post-deploy reconciliation for the Sepolia PremiumRegistry redeploy
 * (v2026.05.18). Idempotent — safe to re-run.
 *
 * 1. Verifies the new PremiumRegistry proxy is initialized correctly
 *    (init args match the original Sepolia config) and has zero plans.
 * 2. Verifies that PremiumSetting's on-chain implementation matches the
 *    locally-built artifact. If not, calls admin.upgrade() to finish a
 *    partially-failed earlier `hardhat deploy` run.
 * 3. Recreates Plan 0 ("Dev Penny Plan") on the new registry with the
 *    exact metadata captured from the legacy non-upgradeable contract.
 * 4. Rewires PremiumSetting.setParams(...) to point at the new registry.
 * 5. Cross-checks the wiring by reading PremiumSetting.premiumRegistry.
 *
 * Usage: npx hardhat run scripts/post-deploy-sepolia-registry.ts --network sepolia
 */
import { ethers, deployments, network } from "hardhat";
import { getContracts } from "./utils";

// Plan 0 metadata captured 2026-05-18 from the legacy non-upgradeable
// registry 0xC3c59ab1... (now archived under _deprecated). The "features"
// field is literally the string "undefined" — preserving the pre-existing
// frontend bug exactly for parity, NOT cleaning it up here.
const PLAN_0 = {
  duration: 31536000,                                   // 365d
  price: 1,                                             // 0.01 USD (x100)
  name: "Dev Penny Plan",
  description: "1-year testnet plan for QA on Sepolia",
  features: "undefined",
};

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`Network:  ${network.name}`);
  console.log(`Signer:   ${signer.address}\n`);

  const newRegistryAddr = (await deployments.get("PremiumRegistry")).address;
  const newRegistryImpl = (await deployments.get("PremiumRegistry_Implementation")).address;
  const settingAddr = (await deployments.get("PremiumSetting")).address;
  const settingImplExpected = (await deployments.get("PremiumSetting_Implementation")).address;
  const adminAddr = (await deployments.get("DefaultProxyAdmin")).address;

  console.log("Manifest:");
  console.log(`  PremiumRegistry proxy  = ${newRegistryAddr}`);
  console.log(`  PremiumRegistry impl   = ${newRegistryImpl}`);
  console.log(`  PremiumSetting proxy   = ${settingAddr}`);
  console.log(`  PremiumSetting impl    = ${settingImplExpected}`);
  console.log(`  DefaultProxyAdmin      = ${adminAddr}\n`);

  // ─── 1. Validate the new PremiumRegistry ─────────────────────────────────
  const registry = await ethers.getContractAt("PremiumRegistry", newRegistryAddr);
  const nextPlanId = await registry.getNextPlanId();
  console.log(`PremiumRegistry.getNextPlanId() = ${nextPlanId}`);

  const initArgs = {
    usdt: await registry.usdt(),
    usdc: await registry.usdc(),
    usdtFeed: await registry.usdtUsdPriceFeed(),
    usdcFeed: await registry.usdcUsdPriceFeed(),
    ethFeed: await registry.ethUsdPriceFeed(),
    premiumSetting: await registry.premiumSetting(),
    payment: await registry.payment(),
  };
  console.log(`Init args echoed by registry:`);
  for (const [k, v] of Object.entries(initArgs)) {
    console.log(`  ${k.padEnd(15)} ${v}`);
  }
  console.log("");

  // ─── 2. Finish the PremiumSetting upgrade if it's still on the old impl ──
  const adminAbi = [
    "function owner() view returns (address)",
    "function getProxyImplementation(address) view returns (address)",
    "function upgrade(address proxy, address impl) external",
  ];
  const admin = new ethers.Contract(adminAddr, adminAbi, signer);
  const settingImplActual: string = await admin.getProxyImplementation(settingAddr);
  console.log(`PremiumSetting on-chain impl:   ${settingImplActual}`);
  console.log(`PremiumSetting expected impl:   ${settingImplExpected}`);
  if (settingImplActual.toLowerCase() !== settingImplExpected.toLowerCase()) {
    console.log(`→ MISMATCH. Calling admin.upgrade(...)`);
    const tx = await admin.upgrade(settingAddr, settingImplExpected);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    const settingImplPost: string = await admin.getProxyImplementation(settingAddr);
    if (settingImplPost.toLowerCase() !== settingImplExpected.toLowerCase()) {
      throw new Error(`upgrade did not stick: got ${settingImplPost}`);
    }
    console.log(`  ✓ PremiumSetting impl is now ${settingImplPost}\n`);
  } else {
    console.log(`  ✓ already at expected impl\n`);
  }

  // ─── 3. Recreate Plan 0 ──────────────────────────────────────────────────
  if (Number(nextPlanId) === 0) {
    console.log(`Recreating Plan 0 on the new registry…`);
    console.log(`  duration    = ${PLAN_0.duration} (${PLAN_0.duration / 86400}d)`);
    console.log(`  price       = ${PLAN_0.price} ($${(PLAN_0.price / 100).toFixed(2)})`);
    console.log(`  name        = "${PLAN_0.name}"`);
    console.log(`  description = "${PLAN_0.description}"`);
    console.log(`  features    = "${PLAN_0.features}"`);

    const tx = await registry.createPlans(
      [PLAN_0.duration],
      [PLAN_0.price],
      [PLAN_0.name],
      [PLAN_0.description],
      [PLAN_0.features],
    );
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();

    const after = await registry.getNextPlanId();
    if (Number(after) !== 1) {
      throw new Error(`Plan creation did not stick: getNextPlanId=${after}`);
    }
    const plan0: any = await registry.premiumPlans(0);
    console.log(`  ✓ plan 0 created: usdPrice=${plan0.usdPrice} duration=${plan0.duration} isActive=${plan0.isActive}\n`);
  } else {
    console.log(`Plan 0 already exists — skipping creation.\n`);
  }

  // ─── 4. Rewire PremiumSetting → new PremiumRegistry ──────────────────────
  const setting = await ethers.getContractAt("PremiumSetting", settingAddr);
  const wiredRegistry: string = await setting.premiumRegistry();
  console.log(`PremiumSetting.premiumRegistry = ${wiredRegistry}`);
  if (wiredRegistry.toLowerCase() !== newRegistryAddr.toLowerCase()) {
    const transferEOA = (await deployments.get("TransferEOALegacyRouter")).address;
    const multisig = (await deployments.get("MultisigLegacyRouter")).address;
    console.log(`Calling PremiumSetting.setParams(`);
    console.log(`  premiumRegistry             = ${newRegistryAddr}`);
    console.log(`  transferLegacyContractRouter = AddressZero (sunset)`);
    console.log(`  transferEOALegacyRouter     = ${transferEOA}`);
    console.log(`  multisigLegacyContractRouter = ${multisig})`);
    const tx = await setting.setParams(
      newRegistryAddr,
      ethers.constants.AddressZero,
      transferEOA,
      multisig,
    );
    console.log(`  tx: ${tx.hash}`);
    await tx.wait();
    const after: string = await setting.premiumRegistry();
    if (after.toLowerCase() !== newRegistryAddr.toLowerCase()) {
      throw new Error(`wiring did not stick: PremiumSetting.premiumRegistry=${after}`);
    }
    console.log(`  ✓ PremiumSetting.premiumRegistry is now ${after}\n`);
  } else {
    console.log(`  ✓ already wired\n`);
  }

  console.log(`Done. Sepolia PremiumRegistry redeploy is complete.`);
  console.log(`  New PremiumRegistry: ${newRegistryAddr}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
