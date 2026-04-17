import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

/**
 * Delete an EOA legacy by ID on the TransferLegacyEOAContractRouter.
 *
 * This calls deleteLegacy(legacyId) which:
 *   - Sets isCreateLegacy[msg.sender] = false on the router
 *   - Marks the child contract as not-live
 *
 * Usage:
 *   npx hardhat run scripts/delete-eoa-legacy.ts --network sepolia
 *
 * Set LEGACY_ID env var to the legacy to delete (default: 21).
 */
async function main() {
  const network = hre.network.name;
  const [signer] = await ethers.getSigners();
  const legacyId = Number(process.env.LEGACY_ID ?? "21");

  console.log(`Network:   ${network}`);
  console.log(`Signer:    ${signer.address}`);
  console.log(`Legacy ID: ${legacyId}`);

  // Allow overriding the router address for legacies created on an older router deployment
  const contracts = getContracts();
  const routerAddress =
    process.env.ROUTER_ADDRESS ||
    contracts[network]?.TransferEOALegacyRouter?.address;
  if (!routerAddress) {
    throw new Error(
      `No TransferEOALegacyRouter address for "${network}". Set ROUTER_ADDRESS env var for old routers.`
    );
  }
  console.log(`Router:    ${routerAddress}`);

  const minAbi = [
    "function deleteLegacy(uint256 legacyId_) external",
    "function isCreateLegacy(address) view returns (bool)",
    "function legacyAddresses(uint256) view returns (address)",
  ];
  const router = new ethers.Contract(routerAddress, minAbi, signer);

  // Pre-flight checks
  const isCreated = await router.isCreateLegacy(signer.address);
  console.log(`isCreateLegacy(${signer.address}): ${isCreated}`);
  if (!isCreated) {
    console.log("Nothing to delete — isCreateLegacy is already false.");
    return;
  }

  const legacyAddress = await router.legacyAddresses(legacyId);
  console.log(`Legacy contract: ${legacyAddress}`);
  if (legacyAddress === ethers.constants.AddressZero) {
    throw new Error(`Legacy ID ${legacyId} does not exist`);
  }

  console.log(`\nSending deleteLegacy(${legacyId})...`);
  const tx = await router.deleteLegacy(legacyId);
  console.log(`Tx hash: ${tx.hash}`);
  console.log("Waiting for confirmation...");
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`);

  const isCreatedAfter = await router.isCreateLegacy(signer.address);
  console.log(`\nisCreateLegacy(${signer.address}) after delete: ${isCreatedAfter}`);
  console.log(isCreatedAfter ? "WARNING: flag still true!" : "Success — you can now create a new legacy.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
