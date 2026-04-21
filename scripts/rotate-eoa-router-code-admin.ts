/**
 * Rotates `_codeAdmin` on TransferEOALegacyRouter by calling `initializeV2(newAdmin)`.
 *
 * The router's `_codeAdmin` on Sepolia is set to the previous dev's wallet
 * (0x974763…886f), which we no longer control. The current impl exposes
 * `initializeV2(address)` gated only by `reinitializer(3)`. On Sepolia the
 * initializer version is still 2, so we can call it and claim the role.
 *
 * WARNING: `initializeV2` has no access control other than the reinitializer
 * gate — it is front-runnable. On testnet the risk is negligible. On mainnet,
 * bundle the rotation + `setLegacyImplementation` atomically via a private tx
 * pool or a multicall to prevent a malicious front-run.
 */
import { ethers, deployments, network } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Router:   ${routerAddr}`);

  const INITIALIZABLE_STORAGE =
    "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
  const vRaw = await ethers.provider.getStorageAt(routerAddr, INITIALIZABLE_STORAGE);
  const version = BigInt("0x" + vRaw.slice(-16));
  console.log(`Initializable version: ${version}`);
  if (version >= 3n) {
    throw new Error(`initializeV2 already called (version=${version}); cannot rotate via this path.`);
  }

  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr, deployer as any);
  console.log(`\nCalling initializeV2(${deployerAddr}) …`);
  const tx = await router.initializeV2(deployerAddr);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  confirmed (gas used: ${receipt.gasUsed.toString()})`);

  const vRaw2 = await ethers.provider.getStorageAt(routerAddr, INITIALIZABLE_STORAGE);
  const version2 = BigInt("0x" + vRaw2.slice(-16));
  console.log(`New Initializable version: ${version2} (expected: 3)`);

  const codeAdminRaw = await ethers.provider.getStorageAt(routerAddr, 10);
  const codeAdmin = ethers.utils.getAddress("0x" + codeAdminRaw.slice(-40));
  console.log(`New _codeAdmin: ${codeAdmin}`);
  if (codeAdmin.toLowerCase() !== deployerAddr.toLowerCase()) {
    throw new Error(`Rotation did not stick — slot 10 is ${codeAdmin}, expected ${deployerAddr}`);
  }
  console.log("Rotation successful.");
}
main().catch((e) => { console.error(e); process.exit(1); });
