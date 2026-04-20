import { ethers } from "hardhat";

// Mainnet LINK + manager. Read-only check, safe to run anytime.
const LINK = "0x514910771AF9Ca656af840dff83E8264EcF986CA";
// From contract-addresses.json (mainnet section). Corrected after initial
// mix-up with the localhost entry (0x202CCe...).
const MANAGER_IN_JSON = "0x03db2dcED84AEcb21F9e399f4dC7B71302537265";
const PREMIUM_SETTING = "0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f";

async function main() {
  // 1. Source of truth: what does the live PremiumSetting point to?
  const setting = await ethers.getContractAt(
    ["function premiumAutomationManager() view returns (address)"],
    PREMIUM_SETTING
  );
  const wiredManager = (await (
    setting as any
  ).premiumAutomationManager()) as string;
  console.log(`PremiumSetting.premiumAutomationManager(): ${wiredManager}`);
  console.log(`contract-addresses.json mainnet entry:     ${MANAGER_IN_JSON}`);
  if (wiredManager.toLowerCase() !== MANAGER_IN_JSON.toLowerCase()) {
    console.log(
      "  WARNING: json entry does not match the wired manager. Investigate."
    );
  } else {
    console.log("  OK json entry matches the wired manager.");
  }

  const link = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    LINK
  );
  const bal = await (link as any).balanceOf(wiredManager);
  console.log(
    `\nMainnet PremiumAutomationManager LINK balance: ${(
      ethers as any
    ).utils.formatUnits(bal, 18)} LINK`
  );
  if (bal.lt((ethers as any).utils.parseUnits("2", 18))) {
    console.log(
      "  WARNING: manager has less than 2 LINK. Next first-time subscribe from a user with a queued legacy will revert."
    );
  } else {
    console.log("  OK manager is funded.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
