import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";

const setUpLegacy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers } = hre;

  const verifierDeploy = await deployments.get("EIP712LegacyVerifier");
  const legacyDeployerDeploy = await deployments.get("LegacyDeployer");
  const multisigDeploy = await deployments.get("MultisigLegacyRouter");
  const transferDeploy = await deployments.get("TransferLegacyRouter");
  const transferEOADeploy = await deployments.get("TransferEOALegacyRouter");

  // EIP712LegacyVerifier.setRouterAddresses(transferEOA, transfer, multisig)
  console.log("Calling setRouterAddresses on EIP712LegacyVerifier...");
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", verifierDeploy.address);
  const tx1 = await verifier.setRouterAddresses(
    transferEOADeploy.address,
    transferDeploy.address,
    multisigDeploy.address
  );
  await tx1.wait();
  console.log("setRouterAddresses done, tx:", tx1.hash);

  // LegacyDeployer.setParams(multisig, transfer, transferEOA)
  console.log("Calling setParams on LegacyDeployer...");
  const legacyDeployer = await ethers.getContractAt("LegacyDeployer", legacyDeployerDeploy.address);
  const tx2 = await legacyDeployer.setParams(
    multisigDeploy.address,
    transferDeploy.address,
    transferEOADeploy.address
  );
  await tx2.wait();
  console.log("setParams done, tx:", tx2.hash);
};

setUpLegacy.tags = ["init", "set_up_legacy"];
setUpLegacy.dependencies = [
  "EIP712LegacyVerifier",
  "LegacyDeployer",
  "MultisigLegacyRouter",
  "TransferLegacyRouter",
  "TransferEOALegacyRouter",
];
setUpLegacy.id = "set_up_legacy";
export default setUpLegacy;
