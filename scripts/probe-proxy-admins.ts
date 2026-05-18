/**
 * Second probe — calls the admin's getProxyImplementation/getProxyAdmin
 * directly. Distinguishes between "EIP-1967 slot reads wrong" and
 * "admin doesn't have those view functions".
 *
 * Usage: npx hardhat run scripts/probe-proxy-admin2.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

const NAMES = [
  "PremiumRegistry",
  "TransferEOALegacyRouter",
  "MultisigLegacyRouter",
  "LegacyDeployer",
  "PremiumSetting",
  "EIP712LegacyVerifier",
];

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No section for ${network.name}`);

  const adminAddr = contracts["DefaultProxyAdmin"]?.address;
  if (!adminAddr) throw new Error("No DefaultProxyAdmin in manifest");

  console.log(`Network: ${network.name}`);
  console.log(`Admin:   ${adminAddr}`);
  console.log("");

  const adminAbi = [
    "function owner() view returns (address)",
    "function getProxyImplementation(address) view returns (address)",
    "function getProxyAdmin(address) view returns (address)",
  ];
  const admin = new ethers.Contract(adminAddr, adminAbi, ethers.provider);

  try {
    const owner = await admin.owner();
    console.log(`admin.owner() = ${owner}`);
  } catch (e: any) {
    console.log(`admin.owner() reverted: ${e?.message?.slice(0, 120)}`);
  }

  console.log("");
  for (const name of NAMES) {
    const entry = contracts[name];
    if (!entry?.address) continue;
    const proxy = entry.address;
    console.log(`${name} (${proxy})`);
    try {
      const impl = await admin.getProxyImplementation(proxy);
      console.log(`  getProxyImplementation -> ${impl}`);
    } catch (e: any) {
      console.log(`  getProxyImplementation reverted: ${e?.message?.slice(0, 120)}`);
    }
    try {
      const a = await admin.getProxyAdmin(proxy);
      console.log(`  getProxyAdmin          -> ${a}`);
    } catch (e: any) {
      console.log(`  getProxyAdmin reverted: ${e?.message?.slice(0, 120)}`);
    }
  }

  console.log("");
  console.log("Direct admin bytecode size:");
  const code = await ethers.provider.getCode(adminAddr);
  console.log(`  ${(code.length - 2) / 2} bytes`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
