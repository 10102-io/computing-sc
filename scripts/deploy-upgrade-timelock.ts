/**
 * Deploys the UpgradeTimelock (OZ TimelockController) that will own
 * DefaultProxyAdmin. Deployment only — the ownership transfer is a separate,
 * deliberate step (scripts/transfer-proxy-admin-to-timelock.ts).
 *
 *   npx hardhat run scripts/deploy-upgrade-timelock.ts --network <net>
 *
 * Delay per network:
 * - mainnet: 48h — long enough for users to see a queued upgrade and exit,
 *   short enough for a security response. Raisable later via a
 *   self-scheduled `updateDelay` operation.
 * - sepolia/local: 300s — QA needs fast iteration; the mechanics are
 *   identical, only the wait differs.
 *
 * Roles: proposer+canceller = deployer; executor = open (address(0));
 * admin = the timelock itself (constructor hardcodes admin_ = 0).
 */
import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
import { saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

const MAINNET_DELAY = 48 * 60 * 60; // 48h
const TEST_DELAY = 300; // 5 min on sepolia/local

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const minDelay = network.name === "mainnet" ? MAINNET_DELAY : TEST_DELAY;

  console.log(`Network:  ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`minDelay: ${minDelay}s`);

  const proposers = [deployerAddr];
  const executors = [ethers.constants.AddressZero]; // open execution

  console.log("\nDeploying UpgradeTimelock…");
  const Factory = await ethers.getContractFactory("UpgradeTimelock", deployer as any);
  const timelock = await Factory.deploy(minDelay, proposers, executors);
  await timelock.deployed();
  console.log(`UpgradeTimelock deployed: ${timelock.address}`);
  console.log(`  tx: ${timelock.deployTransaction.hash}`);

  // Sanity: role layout is exactly what the policy page will claim.
  const [proposerRole, cancellerRole, executorRole, adminRole] = await Promise.all([
    timelock.PROPOSER_ROLE(),
    timelock.CANCELLER_ROLE(),
    timelock.EXECUTOR_ROLE(),
    timelock.DEFAULT_ADMIN_ROLE(),
  ]);
  const checks: Array<[string, boolean]> = [
    ["deployer is PROPOSER", await timelock.hasRole(proposerRole, deployerAddr)],
    ["deployer is CANCELLER", await timelock.hasRole(cancellerRole, deployerAddr)],
    ["executor is OPEN (address(0))", await timelock.hasRole(executorRole, ethers.constants.AddressZero)],
    ["timelock self-admins", await timelock.hasRole(adminRole, timelock.address)],
    ["deployer is NOT admin", !(await timelock.hasRole(adminRole, deployerAddr))],
    [`minDelay == ${minDelay}`, (await timelock.getMinDelay()).toNumber() === minDelay],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "OK " : "FAIL"} ${label}`);
    if (!ok) throw new Error(`Role sanity check failed: ${label}`);
  }

  saveContract(network.name, "UpgradeTimelock", timelock.address);

  if (shouldVerify(network.name)) {
    console.log("\nVerifying on Etherscan…");
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: timelock.address,
        constructorArguments: [minDelay, proposers, executors],
        // The thin subclass matches the OZ base bytecode too — disambiguate.
        contract: "contracts/common/UpgradeTimelock.sol:UpgradeTimelock",
      });
      console.log("  Etherscan verification: OK");
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).toLowerCase();
      if (msg.includes("already verified")) {
        console.log("  Etherscan verification: already verified");
      } else {
        console.warn("  Etherscan verification failed (non-fatal):", e?.message ?? e);
      }
    }
  }

  console.log("\nNext step (deliberate, one-way):");
  console.log("  npx hardhat run scripts/transfer-proxy-admin-to-timelock.ts --network " + network.name);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
