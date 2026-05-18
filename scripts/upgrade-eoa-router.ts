import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, saveContract, shouldVerify, verifyProxyOnEtherscan } from "./utils";

/**
 * Upgrade the TransferEOALegacyRouter proxy to the latest implementation.
 *
 * Shipped in `v2026.05.18` to land the H-2 fix (`setPrivateCodeAndCronjob`
 * is now wrapped in a try/catch that emits `PrivateCodeSetupNotCompleted`
 * instead of bricking the whole `createLegacy` tx if the premium hook
 * reverts).
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-eoa-router.ts --network sepolia
 *   npx hardhat run scripts/upgrade-eoa-router.ts --network mainnet
 *
 * Requires:
 *   - DEPLOYER_PRIVATE_KEY (or DEV_DEPLOYER_PRIVATE_KEY for Sepolia) in `.env`
 *   - The deployer must be the owner of DefaultProxyAdmin
 *   - `contract-addresses.json` must have entries for the current network
 *
 * The upgrade is a plain `proxyAdmin.upgrade(...)` — no initializer needs
 * to run. The H-2 fix only wraps an existing external call in try/catch
 * and adds an event; no new storage. Storage layout is preserved
 * exactly so the existing `legacyImplementation` slot (clone target) is
 * unchanged. Run `deploy-eoa-clone-impl.ts` separately to also swap in
 * the new `TransferEOALegacy` clone target (C-1 + M-4 fixes).
 *
 * NOT to be confused with `mainnet-upgrade-eoa-router.ts`, which is the
 * one-time initializeV3 escape-hatch upgrade used in Apr 2026 to rotate
 * `_codeAdmin`. That work is done; this script is for ongoing
 * impl-only upgrades.
 *
 * Idempotent: re-running when the on-chain impl already matches the
 * freshly built bytecode is a no-op.
 */
async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);

  const contracts = getContracts();
  const networkContracts = contracts[network];
  if (!networkContracts) {
    throw new Error(`No contract addresses found for network "${network}" in contract-addresses.json`);
  }

  const proxyAdminAddr = networkContracts["DefaultProxyAdmin"]?.address;
  const routerProxyAddr = networkContracts["TransferEOALegacyRouter"]?.address;
  const oldImplAddr = networkContracts["TransferEOALegacyRouter"]?.implementation;

  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!routerProxyAddr) throw new Error("TransferEOALegacyRouter proxy address not found");

  console.log(`\nProxy admin:        ${proxyAdminAddr}`);
  console.log(`Router proxy:       ${routerProxyAddr}`);
  console.log(`Old implementation: ${oldImplAddr ?? "(unknown)"}`);

  const proxyAdmin = await ethers.getContractAt(
    [
      "function owner() view returns (address)",
      "function getProxyImplementation(address) view returns (address)",
      "function upgrade(address,address)"
    ],
    proxyAdminAddr
  );

  const adminOwner = await proxyAdmin.owner();
  if (adminOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `Deployer ${deployer.address} is not the ProxyAdmin owner (${adminOwner}). Use the correct private key.`
    );
  }

  const currentImpl = await proxyAdmin.getProxyImplementation(routerProxyAddr);
  console.log(`Current on-chain implementation: ${currentImpl}`);

  // Sanity: the legacyImplementation (clone target) slot must be set on
  // the existing proxy — both Sepolia and mainnet have been on the clone
  // path since Apr 2026. If it's zero something has gone sideways and we
  // shouldn't proceed with a plain upgrade without investigating.
  try {
    const router = await ethers.getContractAt("TransferEOALegacyRouter", routerProxyAddr);
    const currentCloneTarget: string = await router.legacyImplementation();
    if (currentCloneTarget === ethers.constants.AddressZero) {
      console.warn(
        "\n⚠ Router currently has legacyImplementation = 0x0 — clone path is disabled. " +
        "Run `deploy-eoa-clone-impl.ts` after this upgrade to point it at a fresh clone target."
      );
    } else {
      console.log(`Current clone target (legacyImplementation): ${currentCloneTarget}`);
    }
  } catch (e: any) {
    console.warn("Could not read legacyImplementation (router may be on a pre-clone impl):", e?.message ?? e);
  }

  console.log("\nDeploying new TransferEOALegacyRouter implementation...");
  const Factory = await ethers.getContractFactory("TransferEOALegacyRouter");
  const newImpl = await Factory.deploy();
  await newImpl.deployed();
  console.log(`New implementation deployed: ${newImpl.address}`);

  if (currentImpl.toLowerCase() === newImpl.address.toLowerCase()) {
    console.log("\nImplementation bytecode is unchanged — nothing to upgrade.");
    return;
  }

  console.log("\nUpgrading proxy...");
  const tx = await proxyAdmin.upgrade(routerProxyAddr, newImpl.address);
  console.log(`Upgrade tx: ${tx.hash}`);
  await tx.wait(1);
  console.log("Upgrade confirmed.");

  const verifiedImpl = await proxyAdmin.getProxyImplementation(routerProxyAddr);
  console.log(`Verified on-chain implementation: ${verifiedImpl}`);

  saveContract(network, "TransferEOALegacyRouter", routerProxyAddr, newImpl.address);
  console.log("contract-addresses.json updated.");

  if (shouldVerify(network)) {
    console.log("\nVerifying new implementation on Etherscan...");
    try {
      await hre.run("verify:verify", {
        address: newImpl.address,
        constructorArguments: [],
      });
      console.log("Etherscan source verification complete.");
    } catch (e: any) {
      if (e.message?.includes("Already Verified")) {
        console.log("Already verified on Etherscan.");
      } else {
        console.warn("Etherscan verification failed:", e.message ?? e);
      }
    }

    const apiKey = process.env.API_KEY_ETHERSCAN;
    const chainId = hre.network.config?.chainId;
    if (apiKey && chainId != null) {
      try {
        const result = await verifyProxyOnEtherscan(
          routerProxyAddr,
          newImpl.address,
          chainId,
          apiKey
        );
        console.log(result.success
          ? `Etherscan proxy link: ${result.message}`
          : `Etherscan proxy verification: ${result.message}`
        );
      } catch (e) {
        console.warn("Etherscan proxy verification failed:", e);
      }
    }
  }

  console.log("\nDone. TransferEOALegacyRouter upgraded successfully.");
  console.log("Next step: deploy a fresh TransferEOALegacy clone impl with `npx hardhat run scripts/deploy-eoa-clone-impl.ts --network " + network + "`");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
