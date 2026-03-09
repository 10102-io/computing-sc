/**
 * Wires TransferEOALegacyRouter into the rest of the system on Sepolia.
 * Run after deploy-eoa-router.ts when adding the EOA router to a network for the first time.
 *
 * Calls:
 *   EIP712LegacyVerifier.setRouterAddresses(transferEOA, transfer, multisig)
 *   LegacyDeployer.setParams(multisig, transfer, transferEOA)
 *   PremiumSetting.setParams(premiumRegistry, transfer, transferEOA, multisig)
 *
 * Run: npx hardhat run scripts/wire-eoa-router-sepolia.ts --network sepolia
 */
import { network, ethers } from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contracts for network ${network.name}`);

  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);
  console.log("Network:", network.name);

  const verifierAddr = contracts.EIP712LegacyVerifier?.address;
  const legacyDeployerAddr = contracts.LegacyDeployer?.address;
  const transferEOAAddr = contracts.TransferEOALegacyRouter?.address;
  const transferAddr = contracts.TransferLegacyRouter?.address;
  const multisigAddr = contracts.MultisigLegacyRouter?.address;
  const premiumSettingAddr = contracts.PremiumSetting?.address;
  const premiumRegistryAddr = contracts.PremiumRegistry?.address;

  if (!verifierAddr || !legacyDeployerAddr || !transferEOAAddr || !transferAddr || !multisigAddr || !premiumSettingAddr || !premiumRegistryAddr) {
    throw new Error("Missing required addresses in contract-addresses.json");
  }

  console.log("Addresses:", { verifierAddr, legacyDeployerAddr, transferEOAAddr, transferAddr, multisigAddr, premiumSettingAddr, premiumRegistryAddr });

  // EIP712LegacyVerifier.setRouterAddresses(transferEOA, transfer, multisig)
  console.log("\nCalling setRouterAddresses on EIP712LegacyVerifier...");
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", verifierAddr);
  const tx1 = await (verifier as any).setRouterAddresses(transferEOAAddr, transferAddr, multisigAddr);
  await tx1.wait();
  console.log("setRouterAddresses done, tx:", tx1.hash);

  // LegacyDeployer.setParams(multisig, transfer, transferEOA)
  console.log("\nCalling setParams on LegacyDeployer...");
  const legacyDeployer = await ethers.getContractAt("LegacyDeployer", legacyDeployerAddr);
  const tx2 = await (legacyDeployer as any).setParams(multisigAddr, transferAddr, transferEOAAddr);
  await tx2.wait();
  console.log("setParams done, tx:", tx2.hash);

  // PremiumSetting.setParams(premiumRegistry, transfer, transferEOA, multisig)
  console.log("\nCalling setParams on PremiumSetting...");
  const premiumSetting = await ethers.getContractAt("PremiumSetting", premiumSettingAddr);
  const tx3 = await (premiumSetting as any).setParams(premiumRegistryAddr, transferAddr, transferEOAAddr, multisigAddr);
  await tx3.wait();
  console.log("setParams done, tx:", tx3.hash);

  console.log("\nDone. TransferEOALegacyRouter is wired up.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
