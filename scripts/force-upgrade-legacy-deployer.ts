/**
 * One-off: force the LegacyDeployer proxy to point at the new implementation.
 *
 * This exists because hardhat-deploy's first attempt at upgrading this proxy
 * reverted (it tried `upgradeAndCall(proxy, newImpl, initialize())` which fails
 * on an already-initialized proxy). The impl bytecode at
 *   0x9A62F82733Feb27a5eB6E62A4c393678d02FD4Cc
 * is already on-chain and Etherscan-verified. We just need to flip the proxy.
 *
 * Once hardhat-deploy's artifact state is consistent with the proxy being
 * upgraded, normal `hardhat deploy --tags LegacyDeployer` works again for
 * future upgrades (the `init`/`onUpgrade` fix is already in place).
 */
import { ethers, deployments, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const proxy = (await deployments.get("LegacyDeployer")).address;
  const admin = (await deployments.get("DefaultProxyAdmin")).address;
  const targetImpl = "0x9A62F82733Feb27a5eB6E62A4c393678d02FD4Cc";

  console.log(`Network:     ${network.name}`);
  console.log(`Deployer:    ${await deployer.getAddress()}`);
  console.log(`Proxy:       ${proxy}`);
  console.log(`Admin:       ${admin}`);
  console.log(`Target impl: ${targetImpl}`);

  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dcef62088f0ccdbff21c6a9c7e90d17b9";
  const currentImplRaw = await ethers.provider.getStorageAt(proxy, IMPL_SLOT);
  const currentImpl = ethers.utils.getAddress("0x" + currentImplRaw.slice(-40));
  console.log(`Current impl: ${currentImpl}`);

  if (currentImpl.toLowerCase() === targetImpl.toLowerCase()) {
    console.log("Already at target impl — nothing to do.");
    return;
  }

  const adminAbi = [
    "function upgrade(address proxy, address implementation) external",
    "function owner() view returns (address)",
  ];
  const adminContract = new ethers.Contract(admin, adminAbi, deployer);
  const adminOwner: string = await adminContract.owner();
  console.log(`Admin owner:  ${adminOwner}`);
  if (adminOwner.toLowerCase() !== (await deployer.getAddress()).toLowerCase()) {
    throw new Error(`Deployer is not the admin owner; cannot upgrade. Admin owner = ${adminOwner}`);
  }

  console.log(`\nIssuing admin.upgrade(...) ...`);
  const tx = await adminContract.upgrade(proxy, targetImpl);
  console.log(`tx hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`);

  const postImplRaw = await ethers.provider.getStorageAt(proxy, IMPL_SLOT);
  const postImpl = ethers.utils.getAddress("0x" + postImplRaw.slice(-40));
  console.log(`New impl:    ${postImpl}`);
  if (postImpl.toLowerCase() !== targetImpl.toLowerCase()) {
    throw new Error("Upgrade did not stick — investigate.");
  }
  console.log("Upgrade successful.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
