/**
 * Upgrades TransferLegacyRouter to the latest implementation.
 * No re-initialisation needed — upgrade only.
 *
 * Run: npx hardhat run scripts/upgrade-transfer-legacy-router.ts --network sepolia
 *      npx hardhat run scripts/upgrade-transfer-legacy-router.ts --network mainnet
 *
 * Prerequisites: RPC / SEPOLIA_RPC_URL and DEPLOYER_PRIVATE_KEY in .env;
 * deployer must be owner of DefaultProxyAdmin.
 */
import { network, ethers } from "hardhat";
import { getContracts, saveContract } from "./utils";

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) {
    throw new Error(`No contracts for network ${network.name}`);
  }

  const proxyAdminAddr = contracts.DefaultProxyAdmin?.address;
  const routerAddr = contracts.TransferLegacyRouter?.address;

  if (!proxyAdminAddr || !routerAddr) {
    throw new Error("Missing DefaultProxyAdmin or TransferLegacyRouter in contract-addresses.json");
  }

  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);
  console.log("Network:", network.name);

  // Deploy new implementation
  const TransferLegacyRouter = await ethers.getContractFactory("TransferLegacyRouter");
  const impl = await TransferLegacyRouter.deploy();
  await impl.deployed();
  console.log("TransferLegacyRouter new implementation:", impl.address);

  // Upgrade proxy (no data / re-initialisation needed)
  const proxyAdminAbi = [
    "function upgrade(address proxy, address implementation) public",
  ];
  const proxyAdmin = new ethers.Contract(proxyAdminAddr, proxyAdminAbi, signer as any);
  const tx = await proxyAdmin.upgrade(routerAddr, impl.address);
  await tx.wait();
  console.log("Upgraded TransferLegacyRouter proxy, tx:", tx.hash);

  saveContract(network.name, "TransferLegacyRouter", routerAddr, impl.address);
  console.log("Updated contract-addresses.json with new implementation address.");
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
