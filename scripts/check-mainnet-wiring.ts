/**
 * Check all wiring on mainnet contracts.
 * Run: npx hardhat run scripts/check-mainnet-wiring.ts --network mainnet
 */
import { ethers } from "hardhat";

async function main() {
  const ZERO = ethers.constants.AddressZero;

  // Addresses from deployments (lowercased so getAddress can checksum them)
  const cs = (a: string) => ethers.utils.getAddress(a.toLowerCase());
  const addresses = {
    EIP712LegacyVerifier: cs("0x3d6cC3782EC0DF21B58c4C9F5ecf23e485e05F9e"),
    LegacyDeployer: cs("0x4bA22dC3Ab261C7C5c429770af5e6908bE46050f"),
    PremiumSetting: cs("0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f"),
    TransferLegacyRouter: cs("0x7e173738f0bE8B4bDbA28CF91b0F5B0263Aa4b0C"),
    TransferEOALegacyRouter: cs("0x4E81E1Ed3F6684EB948F8956b8787967b1a6275b"),
    MultisigLegacyRouter: cs("0x7c7bf503DF70eBE3520f65Cc0Ff1aF093Fa85038"),
    PremiumRegistry: cs("0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27"),
  };

  const check = async (label: string, fn: () => Promise<string>) => {
    try {
      const val = await fn();
      const status = val === ZERO ? "*** NOT SET ***" : "OK";
      console.log(`  ${label}: ${val} ${status}`);
    } catch (e: any) {
      console.log(`  ${label}: *** ERROR *** ${e.code || e.message}`);
    }
  };

  console.log("=== EIP712LegacyVerifier ===");
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", addresses.EIP712LegacyVerifier);
  await check("transferLegacyEOA", () => verifier.transferLegacyEOA());
  await check("transferLegacy", () => verifier.transferLegacy());
  await check("multisigLegacy", () => verifier.multisigLegacy());

  console.log("\n=== LegacyDeployer ===");
  const deployer = await ethers.getContractAt("LegacyDeployer", addresses.LegacyDeployer);
  await check("multisigLegacyRouter", () => deployer.multisigLegacyRouter());
  await check("transferLegacyRouter", () => deployer.transferLegacyRouter());
  await check("transferEOALegacyRouter", () => deployer.transferEOALegacyRouter());

  console.log("\n=== PremiumSetting ===");
  const setting = await ethers.getContractAt("PremiumSetting", addresses.PremiumSetting);
  await check("transferLegacyContractRouter", () => setting.transferLegacyContractRouter());
  await check("transferLegacyEOAContractRouter", () => setting.transferLegacyEOAContractRouter());
  await check("multisigLegacyContractRouter", () => setting.multisigLegacyContractRouter());
  await check("premiumRegistry", () => setting.premiumRegistry());

  console.log("\n=== TransferEOALegacyRouter ===");
  const eoa = await ethers.getContractAt("TransferEOALegacyRouter", addresses.TransferEOALegacyRouter);
  await check("premiumSetting", () => eoa.premiumSetting());
  await check("paymentContract", () => eoa.paymentContract());
  await check("verifier", () => eoa.verifier());
  await check("legacyDeployerContract", () => eoa.legacyDeployerContract());

  // Check the actual LegacyDeployer that TransferEOALegacyRouter references
  console.log("\n=== Actual LegacyDeployer (from TransferEOALegacyRouter) ===");
  const actualDeployer = cs("0xdb6B6487e020479120dd3e596Ff5A530eD7C88a7");
  const code = await ethers.provider.getCode(actualDeployer);
  console.log("  Address:", actualDeployer, "has code:", code.length > 2 ? "YES" : "NO");
  if (code.length > 2) {
    const deployer2 = await ethers.getContractAt("LegacyDeployer", actualDeployer);
    await check("multisigLegacyRouter", () => deployer2.multisigLegacyRouter());
    await check("transferLegacyRouter", () => deployer2.transferLegacyRouter());
    await check("transferEOALegacyRouter", () => deployer2.transferEOALegacyRouter());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
