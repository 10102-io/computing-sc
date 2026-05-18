import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers as ethersLib } from "ethers";

// Safe-source Transfer (`TransferLegacyRouter` + `TransferLegacyContract`)
// was hard-sunset in v2026.05.18. The wiring slots are preserved on every
// downstream contract for storage-layout compatibility, but on fresh
// deployments we pass address(0) — the EOA and Multisig flows are the only
// remaining live paths.
const SUNSET_TRANSFER_ROUTER = ethersLib.constants.AddressZero;

const setUpLegacy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers } = hre;

  const verifierDeploy = await deployments.get("EIP712LegacyVerifier");
  const legacyDeployerDeploy = await deployments.get("LegacyDeployer");
  const multisigDeploy = await deployments.get("MultisigLegacyRouter");
  const transferEOADeploy = await deployments.get("TransferEOALegacyRouter");
  const premiumRegistryDeploy = await deployments.get("PremiumRegistry");
  const premiumSettingDeploy = await deployments.get("PremiumSetting");

  // EIP712LegacyVerifier.setRouterAddresses(transferEOA, transfer, multisig)
  console.log("Calling setRouterAddresses on EIP712LegacyVerifier...");
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", verifierDeploy.address);
  const tx1 = await verifier.setRouterAddresses(
    transferEOADeploy.address,
    SUNSET_TRANSFER_ROUTER,
    multisigDeploy.address
  );
  await tx1.wait();
  console.log("setRouterAddresses done, tx:", tx1.hash);

  // LegacyDeployer.setParams(multisig, transfer, transferEOA)
  console.log("Calling setParams on LegacyDeployer...");
  const legacyDeployer = await ethers.getContractAt("LegacyDeployer", legacyDeployerDeploy.address);
  const tx2 = await legacyDeployer.setParams(
    multisigDeploy.address,
    SUNSET_TRANSFER_ROUTER,
    transferEOADeploy.address
  );
  await tx2.wait();
  console.log("setParams done, tx:", tx2.hash);

  // PremiumSetting.setParams(premiumRegistry, transfer, transferEOA, multisig)
  console.log("Calling setParams on PremiumSetting...");
  const premiumSetting = await ethers.getContractAt("PremiumSetting", premiumSettingDeploy.address);
  const tx3 = await premiumSetting.setParams(
    premiumRegistryDeploy.address,
    SUNSET_TRANSFER_ROUTER,
    transferEOADeploy.address,
    multisigDeploy.address
  );
  await tx3.wait();
  console.log("PremiumSetting.setParams done, tx:", tx3.hash);
};

setUpLegacy.tags = ["init", "set_up_legacy"];
setUpLegacy.dependencies = [
  "EIP712LegacyVerifier",
  "LegacyDeployer",
  "MultisigLegacyRouter",
  "TransferEOALegacyRouter",
  "PremiumRegistry",
  "PremiumSetting",
];
setUpLegacy.id = "set_up_legacy";
export default setUpLegacy;
