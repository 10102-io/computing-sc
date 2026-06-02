import { ethers } from "hardhat";
import { getContracts } from "./utils";

/**
 * One-shot Sepolia E2E helper for the Phase B reminder pipeline.
 *
 * Grants premium to the deployer via PremiumRegistry.subrcribeByAdmin (OPERATOR,
 * no payment), then emits a real LegacyEmailNotifyRequested by calling
 * PremiumSetting.triggerOwnerResetReminder on a deployer-owned legacy (owner is
 * allowed by onlyRouter). The off-chain worker should then index + send the email.
 *
 *   npx hardhat run scripts/sepolia-e2e-reminder-test.ts --network sepolia
 *
 * Env:
 *   PLAN_ID         (default 0)
 *   TEST_LEGACY     (default a known deployer-owned Sepolia legacy)
 */
async function main() {
  const c = getContracts()["sepolia"];
  const [signer] = await ethers.getSigners();
  const me = await signer.getAddress();

  const registry = await ethers.getContractAt("PremiumRegistry", c["PremiumRegistry"].address, signer);
  const setting = await ethers.getContractAt("PremiumSetting", c["PremiumSetting"].address, signer);

  const planId = Number(process.env.PLAN_ID ?? 0);
  const legacy = (process.env.TEST_LEGACY ?? "0x15498dbf82615a4cbac7ec8433494db8db69dcdc").toLowerCase();

  console.log(`Signer/creator: ${me}`);
  console.log(`Registry:       ${registry.address}`);
  console.log(`Setting:        ${setting.address}`);
  console.log(`Test legacy:    ${legacy}`);

  // 1. ensure deployer has OPERATOR
  const OPERATOR = await registry.OPERATOR();
  const hasOp = await registry.hasRole(OPERATOR, me);
  console.log(`OPERATOR role:  ${hasOp}`);
  if (!hasOp) throw new Error("Deployer lacks OPERATOR on PremiumRegistry — cannot subrcribeByAdmin.");

  // 2. plan must have a non-zero duration
  const duration = await registry.getPlanDuration(planId);
  console.log(`Plan ${planId} duration: ${duration.toString()}s`);
  if (duration.eq(0)) throw new Error(`Plan ${planId} has zero duration — pick another PLAN_ID.`);

  // 3. grant premium if not already
  let premium = await setting.isPremium(me);
  console.log(`isPremium(before): ${premium}`);
  if (!premium) {
    const tx = await registry.subrcribeByAdmin(me, planId, "phaseB-e2e");
    console.log(`subrcribeByAdmin tx: ${tx.hash}`);
    await tx.wait(1);
    premium = await setting.isPremium(me);
  }
  console.log(`isPremium(after):  ${premium}`);
  if (!premium) throw new Error("Premium grant did not take effect.");

  // 4. sanity: legacy is callable + creator is us
  const lg = await ethers.getContractAt(
    ["function creator() view returns (address)", "function getLayer() view returns (uint8)"],
    legacy
  );
  const creator: string = await lg.creator();
  const layer = await lg.getLayer();
  console.log(`legacy.creator(): ${creator} | layer=${layer}`);
  if (creator.toLowerCase() !== me.toLowerCase()) {
    throw new Error(`Legacy creator ${creator} != signer ${me}. Set TEST_LEGACY to one you created.`);
  }

  // 5. emit the reminder event (owner is permitted by onlyRouter)
  const tx2 = await setting.triggerOwnerResetReminder(legacy);
  console.log(`\ntriggerOwnerResetReminder tx: ${tx2.hash}`);
  const receipt = await tx2.wait(1);

  const topic = setting.interface.getEventTopic("LegacyEmailNotifyRequested");
  const log = receipt.logs.find((l: any) => l.topics[0] === topic);
  if (!log) {
    console.warn("No LegacyEmailNotifyRequested in receipt — was creator premium at emit time?");
  } else {
    const parsed = setting.interface.parseLog(log);
    console.log("\n✓ LegacyEmailNotifyRequested emitted:");
    console.log(`  legacy:     ${parsed.args.legacy}`);
    console.log(`  creator:    ${parsed.args.creator}`);
    console.log(`  layer:      ${parsed.args.layer}`);
    console.log(`  notifyType: ${parsed.args.notifyType} (0=OwnerReset)`);
    console.log(`  block:      ${receipt.blockNumber}`);
  }
  console.log("\nNext: ingest a recipient for this legacy + force a worker /run.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
