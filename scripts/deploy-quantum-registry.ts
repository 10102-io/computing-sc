/**
 * Deploys the QuantumRecoveryRegistry — the append-only, ownerless registry
 * where any account (EOA or Safe) commits a hash of a post-quantum recovery
 * credential. No proxy, no admin: immutability is the point.
 *
 *   npx hardhat run scripts/deploy-quantum-registry.ts --network <net>
 */
import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
import { saveContract, shouldVerify, sleep } from "./utils";

dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();

  console.log(`Network:  ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${deployerAddr}`);

  console.log("\nDeploying QuantumRecoveryRegistry…");
  const Factory = await ethers.getContractFactory("QuantumRecoveryRegistry", deployer as any);
  const registry = await Factory.deploy();
  await registry.deployed();
  console.log(`QuantumRecoveryRegistry deployed: ${registry.address}`);
  console.log(`  tx: ${registry.deployTransaction.hash}`);

  // Sanity: fresh registry has no history for the deployer.
  const count = await registry.commitmentCount(deployerAddr);
  if (!count.eq(0)) throw new Error("Sanity check failed: fresh registry not empty");
  console.log("  OK  fresh registry is empty");

  saveContract(network.name, "QuantumRecoveryRegistry", registry.address);

  if (shouldVerify(network.name)) {
    console.log("\nVerifying on Etherscan…");
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: registry.address,
        constructorArguments: [],
        contract: "contracts/common/QuantumRecoveryRegistry.sol:QuantumRecoveryRegistry",
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

  console.log("\nNext: scripts/sync-ui.ts copies the address into the frontend constants.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
