import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, saveContract, shouldVerify, verifyProxyOnEtherscan } from "./utils";

/**
 * Upgrade the MultisigLegacyRouter proxy to the latest implementation.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-multisig-legacy-router.ts --network sepolia
 *   npx hardhat run scripts/upgrade-multisig-legacy-router.ts --network mainnet
 *
 * Requires:
 *   - DEPLOYER_PRIVATE_KEY (or DEV_DEPLOYER_PRIVATE_KEY for sepolia) in .env
 *   - The deployer must be the owner of DefaultProxyAdmin
 *   - contract-addresses.json must have entries for the current network
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
  const routerProxyAddr = networkContracts["MultisigLegacyRouter"]?.address;
  const oldImplAddr = networkContracts["MultisigLegacyRouter"]?.implementation;

  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!routerProxyAddr) throw new Error("MultisigLegacyRouter proxy address not found");

  console.log(`\nProxy admin:      ${proxyAdminAddr}`);
  console.log(`Router proxy:     ${routerProxyAddr}`);
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

  console.log("\nDeploying new MultisigLegacyRouter implementation...");
  const Factory = await ethers.getContractFactory("MultisigLegacyRouter");
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

  saveContract(network, "MultisigLegacyRouter", routerProxyAddr, newImpl.address);
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

  console.log("\nDone. MultisigLegacyRouter upgraded successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
