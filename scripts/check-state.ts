/**
 * Checks on-chain state for key contracts on the current network.
 *
 * Run: npx hardhat run scripts/check-state.ts --network sepolia
 *      npx hardhat run scripts/check-state.ts --network localhost
 */
import { network, ethers } from "hardhat";
import { getContracts } from "./utils";

async function query(address: string, abi: string[], label: string) {
  const contract = new ethers.Contract(address, abi, ethers.provider as any);
  console.log(`\n=== ${label} (${address}) ===`);
  for (const fragment of abi) {
    const name = fragment.match(/function (\w+)/)?.[1];
    if (!name) continue;
    try {
      const value = await contract[name]();
      console.log(`  ${name.padEnd(35)}`, value);
    } catch {
      console.log(`  ${name.padEnd(35)} (call failed)`);
    }
  }
}

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contracts for network: ${network.name}`);

  const get = (name: string) => contracts[name]?.address;

  const legacyDeployerAddr = get("LegacyDeployer");
  const eoaRouterAddr = get("TransferEOALegacyRouter");
  const transferRouterAddr = get("TransferLegacyRouter");
  const multisigRouterAddr = get("MultisigLegacyRouter");
  const verifierAddr = get("EIP712LegacyVerifier");
  const premiumSettingAddr = get("PremiumSetting");

  if (legacyDeployerAddr) {
    await query(legacyDeployerAddr, [
      "function owner() view returns (address)",
      "function transferEOALegacyRouter() view returns (address)",
      "function transferLegacyRouter() view returns (address)",
      "function multisigLegacyRouter() view returns (address)",
    ], "LegacyDeployer");
  }

  if (eoaRouterAddr) {
    await query(eoaRouterAddr, [
      "function legacyDeployerContract() view returns (address)",
      "function verifier() view returns (address)",
      "function premiumSetting() view returns (address)",
      "function uniswapRouter() view returns (address)",
    ], "TransferEOALegacyRouter");
  }

  if (transferRouterAddr) {
    await query(transferRouterAddr, [
      "function legacyDeployerContract() view returns (address)",
      "function verifier() view returns (address)",
    ], "TransferLegacyRouter");
  }

  if (multisigRouterAddr) {
    await query(multisigRouterAddr, [
      "function legacyDeployerContract() view returns (address)",
      "function verifier() view returns (address)",
    ], "MultisigLegacyRouter");
  }

  if (verifierAddr) {
    await query(verifierAddr, [
      "function owner() view returns (address)",
      "function transferEOALegacyRouter() view returns (address)",
      "function transferLegacyRouter() view returns (address)",
      "function multisigLegacyRouter() view returns (address)",
    ], "EIP712LegacyVerifier");
  }

  if (premiumSettingAddr) {
    await query(premiumSettingAddr, [
      "function owner() view returns (address)",
      "function premiumRegistry() view returns (address)",
      "function transferLegacyContractRouter() view returns (address)",
      "function transferLegacyEOAContractRouter() view returns (address)",
      "function multisigLegacyContractRouter() view returns (address)",
    ], "PremiumSetting");
  }
}

main().catch(console.error);
