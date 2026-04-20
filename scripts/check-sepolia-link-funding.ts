import { ethers } from "hardhat";

// Quick read-only check: is the Sepolia PremiumAutomationManager funded with
// enough LINK to register a Chainlink upkeep? Also prints the user's queue
// length so we can tell whether the next subscribe would trigger an upkeep.
const MANAGER = "0x5B2e634D1a22E74902408EA25D6E221B8A1DfcDE";
const LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789"; // Sepolia LINK
const PREMIUM_SETTING = "0xEA267a1F6D554dD416d26c60eFef9234ebfde95e";

async function main() {
  const [signer] = await ethers.getSigners();
  const user = await signer.getAddress();
  console.log("User:", user);

  const link = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function symbol() view returns (string)",
    ],
    LINK
  );
  const managerBalance = await (link as any).balanceOf(MANAGER);
  console.log(
    `Manager LINK balance: ${(ethers as any).utils.formatUnits(
      managerBalance,
      18
    )} LINK`
  );

  // No public getter for legacyQueuedToAddCronjob. Can only check isPremium
  // and infer from behavior. But we can also check if this user currently has
  // a cronjob address set on the manager; if not and they have queued legacies,
  // subscribing will trigger _createCronjob which pulls 1 LINK.
  const manager = await ethers.getContractAt(
    ["function cronjob(address) view returns (address)"],
    MANAGER
  );
  const userCronjob = (await (manager as any).cronjob(user)) as string;
  console.log(`User cronjob: ${userCronjob}`);

  const setting = await ethers.getContractAt(
    [
      "function isPremium(address) view returns (bool)",
      "function premiumExpired(address) view returns (uint256)",
    ],
    PREMIUM_SETTING
  );
  const isPremium = (await (setting as any).isPremium(user)) as boolean;
  const expired = await (setting as any).premiumExpired(user);
  console.log(
    `User isPremium: ${isPremium}, premiumExpired: ${expired.toString()}`
  );

  console.log("\nSummary:");
  const twoLink = (ethers as any).utils.parseUnits("2", 18);
  if (managerBalance.lt(twoLink)) {
    console.log(
      "  X Manager holds < 2 LINK. Subscribing with a queued legacy will revert."
    );
    console.log(
      "    Fix: send >=2 LINK (Sepolia: " +
        LINK +
        ") to " +
        MANAGER +
        "."
    );
    console.log(
      "    Faucet: https://faucets.chain.link/sepolia (1 faucet run = 10-25 LINK)"
    );
  } else {
    console.log("  OK Manager has enough LINK for a first subscription.");
  }
  if (userCronjob === ethers.constants.AddressZero) {
    console.log(
      "  Note: user has no cronjob yet. First subscribe will mint one (costs 1 LINK)."
    );
  } else {
    console.log(
      "  OK user already has a cronjob at " +
        userCronjob +
        ". No upkeep mint needed on subscribe."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
