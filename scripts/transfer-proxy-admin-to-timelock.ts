/**
 * Transfers DefaultProxyAdmin ownership to the UpgradeTimelock.
 *
 * ⚠ ONE-WAY in practice: after this, every proxy implementation swap (and any
 * further ownership change of DefaultProxyAdmin itself) must be scheduled on
 * the timelock, wait out the delay, and then be executed. Direct
 * hardhat-deploy proxy upgrades from the deployer key will REVERT — use
 * scripts/timelock-op.ts for future upgrade trains.
 *
 * Pre-flight checks are deliberately paranoid; this script refuses to run
 * unless the timelock's role layout matches the published policy exactly.
 *
 *   npx hardhat run scripts/transfer-proxy-admin-to-timelock.ts --network <net>
 */
import { ethers, network, deployments } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log(`Network:  ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${deployerAddr}`);

  const timelockAddr = getContracts()[network.name]?.UpgradeTimelock?.address;
  if (!timelockAddr) {
    throw new Error(`No UpgradeTimelock recorded for ${network.name} in contract-addresses.json — run deploy-upgrade-timelock.ts first.`);
  }
  const proxyAdminDeployment = await deployments.get("DefaultProxyAdmin");
  const proxyAdmin = await ethers.getContractAt(
    proxyAdminDeployment.abi,
    proxyAdminDeployment.address,
    deployer as any
  );
  console.log(`DefaultProxyAdmin: ${proxyAdmin.address}`);
  console.log(`UpgradeTimelock:   ${timelockAddr}`);

  // ── Pre-flight ────────────────────────────────────────────────────────────
  const code = await ethers.provider.getCode(timelockAddr);
  if (code === "0x") throw new Error("Timelock has no code — wrong network or address?");

  const timelock = await ethers.getContractAt("UpgradeTimelock", timelockAddr, deployer as any);
  const [proposerRole, cancellerRole, executorRole, adminRole] = await Promise.all([
    timelock.PROPOSER_ROLE(),
    timelock.CANCELLER_ROLE(),
    timelock.EXECUTOR_ROLE(),
    timelock.DEFAULT_ADMIN_ROLE(),
  ]);
  const preflight: Array<[string, boolean]> = [
    ["deployer is PROPOSER on timelock", await timelock.hasRole(proposerRole, deployerAddr)],
    ["deployer is CANCELLER on timelock", await timelock.hasRole(cancellerRole, deployerAddr)],
    ["executor role is OPEN", await timelock.hasRole(executorRole, ethers.constants.AddressZero)],
    ["timelock self-admins", await timelock.hasRole(adminRole, timelockAddr)],
    ["minDelay > 0", (await timelock.getMinDelay()).gt(0)],
    ["deployer currently owns DefaultProxyAdmin", (await proxyAdmin.owner()).toLowerCase() === deployerAddr.toLowerCase()],
  ];
  for (const [label, ok] of preflight) {
    console.log(`  ${ok ? "OK " : "FAIL"} ${label}`);
    if (!ok) throw new Error(`Pre-flight failed: ${label}`);
  }
  console.log(`  minDelay: ${(await timelock.getMinDelay()).toString()}s`);

  // ── Transfer ──────────────────────────────────────────────────────────────
  console.log("\nTransferring DefaultProxyAdmin ownership to the timelock…");
  const tx = await proxyAdmin.transferOwnership(timelockAddr);
  console.log(`  tx: ${tx.hash}`);
  await tx.wait();

  const newOwner: string = await proxyAdmin.owner();
  console.log(`  DefaultProxyAdmin.owner(): ${newOwner}`);
  if (newOwner.toLowerCase() !== timelockAddr.toLowerCase()) {
    throw new Error("Ownership transfer did not stick — investigate immediately.");
  }

  console.log("\n-----------------------------------------------------------------");
  console.log("DONE — proxy upgrades are now timelocked.");
  console.log("-----------------------------------------------------------------");
  console.log("Future upgrades: scripts/timelock-op.ts (schedule → wait → execute).");
  console.log("Direct hardhat-deploy proxy upgrades from the deployer will revert.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
