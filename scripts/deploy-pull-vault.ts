/**
 * Deploys the LegacyPullVault and wires it into the TransferEOALegacyRouter.
 *
 * The vault is immutable and admin-free; it pins (router proxy, clone
 * implementation codehash) at construction. Because of the codehash pin, the
 * vault must be redeployed whenever the clone implementation rotates — this
 * script therefore reads the router's CURRENT `legacyImplementation()` and
 * builds the vault for exactly that. Run deploy-eoa-clone-impl.ts first if
 * you are also rotating the implementation.
 *
 * Pre-requisites:
 *   1. TransferEOALegacyRouter proxy upgraded to an implementation that
 *      exposes `pullVault()` / `setPullVault()`:
 *        npx hardhat run scripts/upgrade-router-proxy.ts --network <net>
 *   2. `legacyImplementation()` set on the router (clone path active).
 *
 * Then:
 *   npx hardhat run scripts/deploy-pull-vault.ts --network <net>
 *
 * Idempotent: re-running deploys a fresh vault for the current implementation
 * and re-points the router. Existing bindings on the old vault keep serving
 * their legacies (their clones discover the vault through the router — after
 * a rotation, old-vault permits stop being selected for NEW pulls, so plan
 * rotations together with a frontend migration prompt).
 *
 * AFTER deploying to a public network, do the trust-registry legwork that is
 * the entire point of the vault (docs/plans/legacy-pull-vault.md §5):
 *   - verify on Etherscan + Sourcify (this script attempts Etherscan),
 *   - submit the vault address to Blockaid / MetaMask as the legitimate
 *     spender for the dapp domain,
 *   - submit/refresh the ERC-7730 clear-signing descriptor.
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

  // Sanity: the proxy must already run an implementation with the vault
  // surface, otherwise we'd deploy a vault nothing can wire up.
  let previousVault: string;
  try {
    previousVault = await router.pullVault();
  } catch (e) {
    throw new Error(
      "TransferEOALegacyRouter does not expose `pullVault()`. " +
      "Upgrade the router proxy to the vault-aware implementation first (scripts/upgrade-router-proxy.ts)."
    );
  }
  console.log(`Current pullVault: ${previousVault}`);

  const impl: string = await router.legacyImplementation();
  if (impl === ethers.constants.AddressZero) {
    throw new Error(
      "Router has no legacyImplementation set — the vault pins a clone codehash, so the clone path must be active. " +
      "Run scripts/deploy-eoa-clone-impl.ts first."
    );
  }
  console.log(`Pinning to clone implementation: ${impl}`);

  console.log("\nDeploying LegacyPullVault…");
  const Vault = await ethers.getContractFactory("LegacyPullVault", deployer as any);
  const vault = await Vault.deploy(routerAddr, impl);
  await vault.deployed();
  console.log(`LegacyPullVault deployed: ${vault.address}`);
  console.log(`  tx: ${vault.deployTransaction.hash}`);
  console.log(`  cloneCodehash: ${await vault.cloneCodehash()}`);

  const deployedCode = await ethers.provider.getCode(vault.address);
  if (deployedCode === "0x") throw new Error(`Vault ${vault.address} has no code yet; aborting wiring`);

  console.log("\nWiring vault into TransferEOALegacyRouter…");
  const setTx = await router.setPullVault(vault.address);
  console.log(`  setPullVault tx: ${setTx.hash}`);
  await setTx.wait();
  const wired: string = await router.pullVault();
  console.log(`  router.pullVault(): ${wired}`);
  if (wired.toLowerCase() !== vault.address.toLowerCase()) {
    throw new Error("setPullVault did not stick — investigate access control / tx revert");
  }

  saveContract(network.name, "LegacyPullVault", vault.address);

  if (shouldVerify(network.name)) {
    console.log("\nVerifying LegacyPullVault on Etherscan…");
    await sleep(15_000);
    try {
      await run("verify:verify", {
        address: vault.address,
        constructorArguments: [routerAddr, impl],
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
  console.log(`LegacyPullVault:          ${vault.address}`);
  console.log(`Pinned implementation:    ${impl}`);
  console.log(`TransferEOALegacyRouter:  ${routerAddr}`);
  console.log("New createLegacyV2 calls now bind owners to their legacy in the vault;");
  console.log("frontends should sign Permit2 batches with the VAULT as spender.");
  console.log("To roll back: router.setPullVault(address(0)) from the code admin");
  console.log("(pre-vault per-clone spender bundles keep working either way).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
