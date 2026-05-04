/**
 * Deploys a fresh TransferEOALegacy implementation and wires it into the
 * TransferEOALegacyRouter as the EIP-1167 clone target.
 *
 * Pre-requisites (run these BEFORE this script):
 *   1. Upgrade LegacyDeployer proxy on the target network:
 *        npx hardhat deploy --network <net> --tags LegacyDeployer
 *      (adds cloneLegacy + getNextCloneAddress to the deployer)
 *   2. Upgrade TransferEOALegacyRouter proxy on the target network:
 *        npx hardhat deploy --network <net> --tags TransferEOALegacyRouter
 *      (adds legacyImplementation storage + setLegacyImplementation)
 *
 * Then:
 *   npx hardhat run scripts/deploy-eoa-clone-impl.ts --network <net>
 *
 * This script is idempotent — re-running it deploys another fresh impl and
 * re-points the router at it. Existing legacies are unaffected; only NEW
 * createLegacy calls after setLegacyImplementation use the clone path.
 */
import { ethers, network, run, deployments } from "hardhat";
import * as dotenv from "dotenv";
import { saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  console.log(`Network: ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${deployerAddr}`);

  const routerDeployment = await deployments.get("TransferEOALegacyRouter");
  const routerAddr = routerDeployment.address;
  console.log(`TransferEOALegacyRouter proxy: ${routerAddr}`);

  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr, deployer as any);

  // Sanity: router must expose the new clone entrypoints. If these fail, the
  // proxy wasn't upgraded to the new implementation yet — abort and let the
  // user run the prerequisite deploy first rather than leaving a half-wired
  // deployment behind.
  try {
    await router.legacyImplementation();
  } catch (e) {
    throw new Error(
      "TransferEOALegacyRouter does not expose `legacyImplementation()`. " +
      "Run `npx hardhat deploy --network " + network.name + " --tags TransferEOALegacyRouter` first to upgrade the proxy."
    );
  }

  const deployerContractAddr = (await deployments.get("LegacyDeployer")).address;
  const deployerContract = await ethers.getContractAt("LegacyDeployer", deployerContractAddr, deployer as any);
  try {
    // Probe the new view function; reverts if LegacyDeployer isn't on the new impl yet.
    await deployerContract.getNextCloneAddress(
      "0x0000000000000000000000000000000000000001",
      deployerAddr
    );
  } catch (e) {
    throw new Error(
      "LegacyDeployer does not expose `getNextCloneAddress()`. " +
      "Run `npx hardhat deploy --network " + network.name + " --tags LegacyDeployer` first to upgrade the proxy."
    );
  }

  console.log("\nDeploying fresh TransferEOALegacy implementation (clone target)…");
  const TransferEOALegacy = await ethers.getContractFactory("TransferEOALegacy", deployer as any);
  const impl = await TransferEOALegacy.deploy();
  await impl.deployed();
  console.log(`TransferEOALegacy impl deployed: ${impl.address}`);
  console.log(`  tx: ${impl.deployTransaction.hash}`);

  // Confirm the impl is reachable before wiring it up — protects against
  // RPC eventual-consistency weirdness on public endpoints.
  const deployedCode = await ethers.provider.getCode(impl.address);
  if (deployedCode === "0x") throw new Error(`Impl ${impl.address} has no code yet; aborting wiring`);

  console.log("\nWiring clone implementation into TransferEOALegacyRouter…");
  const prevImpl: string = await router.legacyImplementation();
  console.log(`  previous legacyImplementation: ${prevImpl}`);
  const setTx = await router.setLegacyImplementation(impl.address);
  console.log(`  setLegacyImplementation tx: ${setTx.hash}`);
  await setTx.wait();
  const newImpl: string = await router.legacyImplementation();
  console.log(`  new legacyImplementation:      ${newImpl}`);
  if (newImpl.toLowerCase() !== impl.address.toLowerCase()) {
    throw new Error("setLegacyImplementation did not stick — investigate access control / tx revert");
  }

  // Record in the shared address manifest so sync-ui + audit scripts pick it up.
  saveContract(network.name, "TransferEOALegacyImpl", impl.address);

  if (shouldVerify(network.name)) {
    console.log("\nVerifying TransferEOALegacy impl on Etherscan…");
    // Small pause so Etherscan has seen the creation tx.
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: impl.address,
        constructorArguments: [],
      });
      console.log("  Etherscan verification: OK");
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).toLowerCase();
      if (msg.includes("already verified")) {
        console.log("  Etherscan verification: already verified (bytecode match)");
      } else {
        console.warn("  Etherscan verification failed (non-fatal):", e?.message ?? e);
      }
    }
  }

  console.log("\n-----------------------------------------------------------------");
  console.log("SUMMARY");
  console.log("-----------------------------------------------------------------");
  console.log(`TransferEOALegacy impl (clone target): ${impl.address}`);
  console.log(`TransferEOALegacyRouter:                ${routerAddr}`);
  console.log("Next createLegacy calls on this router will deploy EIP-1167 clones (~1.1M gas).");
  console.log("Previously-created legacies are unaffected.");
  console.log("To roll back: call router.setLegacyImplementation(address(0)) from the code admin.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
