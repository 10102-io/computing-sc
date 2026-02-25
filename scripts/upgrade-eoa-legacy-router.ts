/**
 * Upgrades TransferEOALegacyRouter.
 *
 * Run: npx hardhat run scripts/upgrade-eoa-legacy-router.ts --network sepolia
 *
 * Prerequisites: RPC and DEPLOYER_PRIVATE_KEY in .env; deployer must be owner of DefaultProxyAdmin.
 */
import { network, ethers } from "hardhat";
import { getContracts, saveContract } from "./utils";

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) {
    throw new Error(`No contracts for network ${network.name}`);
  }

  const proxyAdminAddr = contracts.DefaultProxyAdmin?.address;
  const routerAddr = contracts.TransferEOALegacyRouter?.address;

  if (!proxyAdminAddr || !routerAddr) {
    throw new Error("Missing DefaultProxyAdmin or TransferEOALegacyRouter in contract-addresses.json");
  }

  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);

  const proxyAdminAbi = ["function upgrade(address proxy, address implementation) public"];
  const proxyAdmin = new ethers.Contract(proxyAdminAddr, proxyAdminAbi, signer as any);

  // Deploy new implementation
  const TransferEOALegacyRouter = await ethers.getContractFactory("TransferEOALegacyRouter");
  const impl = await TransferEOALegacyRouter.deploy();
  await impl.deployed();
  console.log("TransferEOALegacyRouter implementation:", impl.address);

  // Upgrade proxy
  const tx = await proxyAdmin.upgrade(routerAddr, impl.address);
  await tx.wait();
  console.log("Upgraded TransferEOALegacyRouter proxy");

  // Set up code admin and store creation code (storage slot added in this upgrade)
  const routerAbi = [
    "function initializeV2(address codeAdmin_) external",
    "function setLegacyCreationCode(bytes calldata code_) external",
  ];
  const router = new ethers.Contract(routerAddr, routerAbi, signer as any);

  const txInit = await router.initializeV2(signer.address);
  await txInit.wait();
  console.log("initializeV2 done, code admin:", signer.address);

  const TransferEOALegacy = await ethers.getContractFactory("TransferEOALegacy");
  const txSetCode = await router.setLegacyCreationCode(TransferEOALegacy.bytecode);
  await txSetCode.wait();
  console.log("setLegacyCreationCode done, bytecode length:", TransferEOALegacy.bytecode.length);

  // Persist new implementation address
  saveContract(network.name, "TransferEOALegacyRouter", routerAddr, impl.address);
  console.log("Updated contract-addresses.json with new implementation address.");

  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
