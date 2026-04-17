import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, shouldVerify, verifyProxyOnEtherscan } from "./utils";

/**
 * Deploy a new MultisigLegacyRouter implementation contract (does NOT upgrade the proxy).
 * 
 * After deploying, upgrade the proxy manually via Etherscan:
 *   1. Go to DefaultProxyAdmin on Etherscan → Write Contract
 *   2. Call upgrade(proxy, newImplementation) with your owner wallet
 *
 * Usage:
 *   npx hardhat run scripts/deploy-multisig-router-impl.ts --network sepolia
 *   npx hardhat run scripts/deploy-multisig-router-impl.ts --network mainnet
 *
 * Requires in .env:
 *   - DEPLOYER_PRIVATE_KEY (any funded account, does NOT need to be ProxyAdmin owner)
 *   - SEPOLIA_RPC_URL (for sepolia)
 *   - API_KEY_ETHERSCAN (optional, for verification)
 */
async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);

  const contracts = getContracts();
  const networkContracts = contracts[network];
  if (!networkContracts) {
    throw new Error(`No contract addresses found for network "${network}"`);
  }

  const proxyAdminAddr = networkContracts["DefaultProxyAdmin"]?.address;
  const routerProxyAddr = networkContracts["MultisigLegacyRouter"]?.address;
  const oldImplAddr = networkContracts["MultisigLegacyRouter"]?.implementation;

  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!routerProxyAddr) throw new Error("MultisigLegacyRouter proxy address not found");

  console.log(`\nRouter proxy:        ${routerProxyAddr}`);
  console.log(`Old implementation:  ${oldImplAddr ?? "(unknown)"}`);
  console.log(`DefaultProxyAdmin:   ${proxyAdminAddr}`);

  console.log("\nCompiling and deploying new MultisigLegacyRouter implementation...");
  const Factory = await ethers.getContractFactory("MultisigLegacyRouter");
  const newImpl = await Factory.deploy();
  await newImpl.deployed();
  console.log(`\n✓ New implementation deployed: ${newImpl.address}`);

  if (shouldVerify(network)) {
    console.log("\nVerifying on Etherscan...");
    try {
      await hre.run("verify:verify", {
        address: newImpl.address,
        constructorArguments: [],
      });
      console.log("✓ Etherscan source verification complete.");
    } catch (e: any) {
      if (e.message?.includes("Already Verified")) {
        console.log("✓ Already verified on Etherscan.");
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
        if (result.success) {
          console.log(`✓ Etherscan proxy linked: ${result.message}`);
        }
      } catch (e) {
        console.warn("Etherscan proxy verification skipped:", e);
      }
    }
  }

  const etherscanBase = network === "mainnet"
    ? "https://etherscan.io"
    : `https://${network}.etherscan.io`;

  console.log("\n" + "=".repeat(70));
  console.log("MANUAL UPGRADE INSTRUCTIONS");
  console.log("=".repeat(70));
  console.log(`
1. Open DefaultProxyAdmin on Etherscan:
   ${etherscanBase}/address/${proxyAdminAddr}#writeContract

2. Connect your owner wallet

3. Call "upgrade" with these parameters:
   proxy:          ${routerProxyAddr}
   implementation: ${newImpl.address}

4. Confirm the transaction in your wallet

5. After confirmation, verify by reading "getProxyImplementation":
   ${etherscanBase}/address/${proxyAdminAddr}#readContract
   → getProxyImplementation(${routerProxyAddr})
   → Should return: ${newImpl.address}
`);
  console.log("=".repeat(70));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
