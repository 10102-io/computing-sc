/**
 * Calls PremiumSetting.setParams to register the new TransferEOALegacyRouter.
 *
 * Run: npx hardhat run scripts/update-premium-setting.ts --network sepolia
 */
import { network } from "hardhat";
import { ethers } from "ethers";
import { getContracts, getProvider } from "./utils";

const PREMIUM_SETTING_ABI = [
  "function owner() view returns (address)",
  "function premiumRegistry() view returns (address)",
  "function transferLegacyContractRouter() view returns (address)",
  "function transferLegacyEOAContractRouter() view returns (address)",
  "function multisigLegacyContractRouter() view returns (address)",
  "function setParams(address _premiumRegistry, address _transferLegacyContractRouter, address _transferLegacyEOAContractRouter, address _multisigLegacyContractRouter) external",
];

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contracts for network ${network.name}`);

  const premiumSettingAddr = contracts.PremiumSetting?.address;
  const premiumRegistryAddr = contracts.PremiumRegistry?.address;
  const transferLegacyRouterAddr = contracts.TransferLegacyRouter?.address;
  const transferEOALegacyRouterAddr = contracts.TransferEOALegacyRouter?.address;
  const multisigLegacyRouterAddr = contracts.MultisigLegacyRouter?.address;

  if (!premiumSettingAddr || !premiumRegistryAddr || !transferLegacyRouterAddr || !transferEOALegacyRouterAddr || !multisigLegacyRouterAddr) {
    throw new Error("Missing required contract addresses in contract-addresses.json");
  }

  const { wallet } = getProvider();
  console.log("Signer:", wallet.address);

  const premiumSetting = new ethers.Contract(premiumSettingAddr, PREMIUM_SETTING_ABI, wallet);

  // Query current state
  const owner = await premiumSetting.owner();
  const currentEOARouter = await premiumSetting.transferLegacyEOAContractRouter();
  const currentRegistry = await premiumSetting.premiumRegistry();
  const currentTransferRouter = await premiumSetting.transferLegacyContractRouter();
  const currentMultisigRouter = await premiumSetting.multisigLegacyContractRouter();

  console.log("\n=== PremiumSetting current state ===");
  console.log("owner:                         ", owner);
  console.log("premiumRegistry:               ", currentRegistry);
  console.log("transferLegacyContractRouter:  ", currentTransferRouter);
  console.log("transferLegacyEOAContractRouter:", currentEOARouter);
  console.log("multisigLegacyContractRouter:  ", currentMultisigRouter);

  console.log("\n=== Updating to ===");
  console.log("premiumRegistry:               ", premiumRegistryAddr);
  console.log("transferLegacyContractRouter:  ", transferLegacyRouterAddr);
  console.log("transferLegacyEOAContractRouter:", transferEOALegacyRouterAddr);
  console.log("multisigLegacyContractRouter:  ", multisigLegacyRouterAddr);

  const tx = await premiumSetting.setParams(
    premiumRegistryAddr,
    transferLegacyRouterAddr,
    transferEOALegacyRouterAddr,
    multisigLegacyRouterAddr
  );
  console.log("\nTx sent:", tx.hash);
  const receipt = await tx.wait();
  console.log("Receipt:", receipt.transactionHash, "status:", receipt.status);

  // Verify
  const newEOARouter = await premiumSetting.transferLegacyEOAContractRouter();
  console.log("\nVerified transferLegacyEOAContractRouter:", newEOARouter);
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
