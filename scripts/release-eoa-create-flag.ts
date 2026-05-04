import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

/**
 * Self-service "I'm free" flag-release for owners of EOA legacies that have
 * already been activated/claimed by a beneficiary.
 *
 * Background: pre-`v2026.05.<n>` routers, `deleteLegacy` reverts on claimed
 * legacies (the underlying contract's `isActiveLegacy` modifier blocks
 * delete after `_isActive == 2`), which left `isCreateLegacy[owner] = true`
 * with no path back. The new `releaseCreateFlag(legacyId)` entry point on
 * the patched router lets the original owner clear that flag for any of
 * their legacies the system already considers no-longer-live (claimed or
 * deleted).
 *
 * Usage:
 *   LEGACY_ID=<id> npx hardhat run scripts/release-eoa-create-flag.ts --network sepolia
 *
 * The signer must be the legacy's recorded owner; the script no-ops with a
 * clear message if that's not the case or if the legacy is still live.
 */
async function main() {
  const network = hre.network.name;
  const [signer] = await ethers.getSigners();
  const legacyId = Number(process.env.LEGACY_ID ?? "");
  if (!Number.isFinite(legacyId) || legacyId <= 0) {
    throw new Error("Set LEGACY_ID env var to the stuck legacy's numeric id.");
  }

  console.log(`Network:   ${network}`);
  console.log(`Signer:    ${signer.address}`);
  console.log(`Legacy ID: ${legacyId}`);

  const contracts = getContracts();
  const routerAddress =
    process.env.ROUTER_ADDRESS ||
    contracts[network]?.TransferEOALegacyRouter?.address;
  if (!routerAddress) {
    throw new Error(
      `No TransferEOALegacyRouter address for "${network}". Set ROUTER_ADDRESS env var.`
    );
  }
  console.log(`Router:    ${routerAddress}`);

  const minAbi = [
    "function releaseCreateFlag(uint256 legacyId_) external",
    "function isCreateLegacy(address) view returns (bool)",
    "function legacyAddresses(uint256) view returns (address)",
  ];
  const router = await ethers.getContractAt(minAbi, routerAddress);

  // Pre-flight checks
  const isCreated = await router.isCreateLegacy(signer.address);
  console.log(`isCreateLegacy(${signer.address}): ${isCreated}`);
  if (!isCreated) {
    console.log("Nothing to release — flag is already false.");
    return;
  }

  const legacyAddress = await router.legacyAddresses(legacyId);
  console.log(`Legacy contract: ${legacyAddress}`);
  if (legacyAddress === ethers.constants.AddressZero) {
    throw new Error(`Legacy ID ${legacyId} does not exist on ${network}.`);
  }

  const legacy = await ethers.getContractAt(
    [
      "function getLegacyOwner() view returns (address)",
      "function isLive() view returns (bool)",
    ],
    legacyAddress
  );
  const owner = await legacy.getLegacyOwner();
  const live = await legacy.isLive();
  console.log(`Legacy owner: ${owner}`);
  console.log(`Legacy isLive(): ${live}`);
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(
      "Signer is not the legacy's owner — only the original creator can release the flag."
    );
  }
  if (live) {
    throw new Error(
      "Legacy is still live (not claimed and not deleted). Use deleteLegacy instead."
    );
  }

  console.log(`\nSending releaseCreateFlag(${legacyId})...`);
  const tx = await router.releaseCreateFlag(legacyId);
  console.log(`Tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(
    `Confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`
  );

  const after = await router.isCreateLegacy(signer.address);
  console.log(`\nisCreateLegacy(${signer.address}) after: ${after}`);
  console.log(
    after
      ? "WARNING: flag still true!"
      : "Success — you can now create a new legacy with this wallet."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
