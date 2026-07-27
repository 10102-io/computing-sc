/**
 * Upgrade a router proxy to a freshly-deployed implementation.
 * Generalized from upgrade-multisig-legacy-router.ts for the create-flow v2
 * rollout, which upgrades two proxies (EOA legacy router + timelock router).
 *
 * Usage (PowerShell):
 *   $env:ROUTER="TransferEOALegacyRouter"; npx hardhat run scripts/upgrade-router-proxy.ts --network sepolia
 *   $env:ROUTER="TimeLockRouter";          npx hardhat run scripts/upgrade-router-proxy.ts --network sepolia
 *
 * Requires:
 *   - DEPLOYER_PRIVATE_KEY in .env; deployer must own DefaultProxyAdmin
 *   - contract-addresses.json entries for the current network
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts, saveContract, shouldVerify, verifyProxyOnEtherscan } from "./utils";

// Contract name == deployment name for all of these (files may differ).
// EIP712LegacyVerifier rides the same path: it sits behind the same
// DefaultProxyAdmin-managed TransparentProxy as the routers.
const ALLOWED = ["TransferEOALegacyRouter", "TimeLockRouter", "MultisigLegacyRouter", "EIP712LegacyVerifier"];

async function main() {
  const routerName = process.env.ROUTER;
  if (!routerName || !ALLOWED.includes(routerName)) {
    throw new Error(`Set ROUTER to one of: ${ALLOWED.join(", ")}`);
  }

  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Router:   ${routerName}`);

  const networkContracts = getContracts()[network];
  if (!networkContracts) throw new Error(`No contract addresses for "${network}"`);

  const proxyAdminAddr = networkContracts["DefaultProxyAdmin"]?.address;
  const routerProxyAddr = networkContracts[routerName]?.address;
  if (!proxyAdminAddr) throw new Error("DefaultProxyAdmin address not found");
  if (!routerProxyAddr) throw new Error(`${routerName} proxy address not found`);

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
    throw new Error(`Deployer is not the ProxyAdmin owner (${adminOwner}).`);
  }

  const currentImpl = await proxyAdmin.getProxyImplementation(routerProxyAddr);
  console.log(`\nProxy:        ${routerProxyAddr}`);
  console.log(`Current impl: ${currentImpl}`);

  console.log(`\nDeploying new ${routerName} implementation...`);
  const Factory = await ethers.getContractFactory(routerName);
  const newImpl = await Factory.deploy();
  await newImpl.deployed();
  console.log(`New implementation: ${newImpl.address}`);
  console.log(`  tx: ${newImpl.deployTransaction.hash}`);

  console.log("\nUpgrading proxy...");
  const tx = await proxyAdmin.upgrade(routerProxyAddr, newImpl.address);
  console.log(`Upgrade tx: ${tx.hash}`);
  await tx.wait(1);

  const verifiedImpl = await proxyAdmin.getProxyImplementation(routerProxyAddr);
  console.log(`On-chain impl now: ${verifiedImpl}`);
  if (verifiedImpl.toLowerCase() !== newImpl.address.toLowerCase()) {
    throw new Error("Upgrade did not stick — investigate before proceeding.");
  }

  saveContract(network, routerName, routerProxyAddr, newImpl.address);
  console.log("contract-addresses.json updated.");

  if (shouldVerify(network)) {
    console.log("\nVerifying new implementation on Etherscan...");
    try {
      await hre.run("verify:verify", { address: newImpl.address, constructorArguments: [] });
      console.log("Etherscan source verification complete.");
    } catch (e: any) {
      if (e.message?.toLowerCase().includes("already verified")) {
        console.log("Already verified on Etherscan.");
      } else {
        console.warn("Etherscan verification failed (non-fatal):", e.message ?? e);
      }
    }
    const apiKey = process.env.API_KEY_ETHERSCAN;
    const chainId = hre.network.config?.chainId;
    if (apiKey && chainId != null) {
      try {
        const result = await verifyProxyOnEtherscan(routerProxyAddr, newImpl.address, chainId, apiKey);
        console.log(result.success ? `Etherscan proxy link: ${result.message}` : `Proxy verification: ${result.message}`);
      } catch (e) {
        console.warn("Etherscan proxy verification failed:", e);
      }
    }
  }

  console.log(`\nDone. ${routerName} upgraded: ${currentImpl} -> ${newImpl.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
