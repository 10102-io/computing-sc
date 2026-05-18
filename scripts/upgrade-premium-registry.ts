import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, saveContract, shouldVerify, verifyProxyOnEtherscan } from "./utils";

/**
 * Upgrade the PremiumRegistry proxy to the latest implementation.
 *
 * Shipped in `v2026.05.18` to land the M-1 fix (`subcribeWithETH` ETH
 * refund now uses `.call{value:}` so smart-contract wallets can
 * receive their overpayment refund instead of being blocked by the
 * 2300-gas stipend that `.transfer()` imposed).
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-premium-registry.ts --network sepolia
 *   npx hardhat run scripts/upgrade-premium-registry.ts --network mainnet
 *
 * Requires:
 *   - DEPLOYER_PRIVATE_KEY (or DEV_DEPLOYER_PRIVATE_KEY for Sepolia) in `.env`
 *   - The deployer must be the owner of DefaultProxyAdmin
 *   - `contract-addresses.json` must have entries for the current network
 *
 * The upgrade is a plain `proxyAdmin.upgrade(...)` — no initializer
 * needs to run; the M-1 fix only changes the body of an existing
 * external function, no storage changes.
 *
 * Idempotent: re-running when the on-chain impl already matches the
 * freshly built bytecode is a no-op (it skips the upgrade tx).
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
  const registryProxyAddr = networkContracts["PremiumRegistry"]?.address;
  const oldImplAddr = networkContracts["PremiumRegistry"]?.implementation;

  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!registryProxyAddr) throw new Error("PremiumRegistry proxy address not found");

  console.log(`\nProxy admin:        ${proxyAdminAddr}`);
  console.log(`Registry proxy:     ${registryProxyAddr}`);
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

  const currentImpl = await proxyAdmin.getProxyImplementation(registryProxyAddr);
  console.log(`Current on-chain implementation: ${currentImpl}`);

  console.log("\nDeploying new PremiumRegistry implementation...");
  const Factory = await ethers.getContractFactory("PremiumRegistry");
  const newImpl = await Factory.deploy();
  await newImpl.deployed();
  console.log(`New implementation deployed: ${newImpl.address}`);

  if (currentImpl.toLowerCase() === newImpl.address.toLowerCase()) {
    console.log("\nImplementation bytecode is unchanged — nothing to upgrade.");
    return;
  }

  console.log("\nUpgrading proxy...");
  const tx = await proxyAdmin.upgrade(registryProxyAddr, newImpl.address);
  console.log(`Upgrade tx: ${tx.hash}`);
  await tx.wait(1);
  console.log("Upgrade confirmed.");

  const verifiedImpl = await proxyAdmin.getProxyImplementation(registryProxyAddr);
  console.log(`Verified on-chain implementation: ${verifiedImpl}`);

  saveContract(network, "PremiumRegistry", registryProxyAddr, newImpl.address);
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
          registryProxyAddr,
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

  console.log("\nDone. PremiumRegistry upgraded successfully.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
