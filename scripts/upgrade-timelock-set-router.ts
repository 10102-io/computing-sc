/**
 * Upgrades TimeLockRouter, TimelockERC20, TimelockERC721, TimelockERC1155,
 * then calls setRouterAddresses(TimeLockRouter) on each Timelock* so Router→Timelock calls succeed,
 * and setUniswapRouter on TimelockERC20 so the cached WETH is set (required for withdraw-as-ETH swaps).
 *
 * Run: npx hardhat run scripts/upgrade-timelock-set-router.ts --network sepolia
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
  const routerAddr = contracts.TimeLockRouter?.address;
  const timelockERC20Addr = contracts.TimelockERC20?.address;
  const timelockERC721Addr = contracts.TimelockERC721?.address;
  const timelockERC1155Addr = contracts.TimelockERC1155?.address;

  if (!proxyAdminAddr || !routerAddr || !timelockERC20Addr || !timelockERC721Addr || !timelockERC1155Addr) {
    throw new Error("Missing DefaultProxyAdmin, TimeLockRouter or Timelock* in contract-addresses.json");
  }

  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);

  // Use upgrade() not upgradeAndCall(): upgradeAndCall with empty data still delegatecalls the new
  // implementation with empty calldata, which reverts (no matching selector). upgrade() only swaps the impl.
  const proxyAdminAbi = ["function upgrade(address proxy, address implementation) public"];
  const proxyAdmin = new ethers.Contract(proxyAdminAddr, proxyAdminAbi, signer as any);

  // 1. Deploy and upgrade TimeLockRouter
  const TimeLockRouter = await ethers.getContractFactory("TimeLockRouter");
  const implRouter = await TimeLockRouter.deploy();
  await implRouter.deployed();
  console.log("TimeLockRouter implementation:", implRouter.address);

  const txUpRouter = await proxyAdmin.upgrade(routerAddr, implRouter.address);
  await txUpRouter.wait();
  console.log("Upgraded TimeLockRouter proxy");

  // 2. Deploy new Timelock* implementations
  const TimelockERC20 = await ethers.getContractFactory("TimelockERC20");
  const impl20 = await TimelockERC20.deploy();
  await impl20.deployed();
  console.log("TimelockERC20 implementation:", impl20.address);

  const TimelockERC721 = await ethers.getContractFactory("TimelockERC721");
  const impl721 = await TimelockERC721.deploy();
  await impl721.deployed();
  console.log("TimelockERC721 implementation:", impl721.address);

  const TimelockERC1155 = await ethers.getContractFactory("TimelockERC1155");
  const impl1155 = await TimelockERC1155.deploy();
  await impl1155.deployed();
  console.log("TimelockERC1155 implementation:", impl1155.address);

  // 3. Upgrade Timelock* proxies
  const txUp20 = await proxyAdmin.upgrade(timelockERC20Addr, impl20.address);
  await txUp20.wait();
  console.log("Upgraded TimelockERC20 proxy");

  const txUp721 = await proxyAdmin.upgrade(timelockERC721Addr, impl721.address);
  await txUp721.wait();
  console.log("Upgraded TimelockERC721 proxy");

  const txUp1155 = await proxyAdmin.upgrade(timelockERC1155Addr, impl1155.address);
  await txUp1155.wait();
  console.log("Upgraded TimelockERC1155 proxy");

  // Persist new implementation addresses to contract-addresses.json
  const networkKey = network.name;
  saveContract(networkKey, "TimeLockRouter", routerAddr, implRouter.address);
  saveContract(networkKey, "TimelockERC20", timelockERC20Addr, impl20.address);
  saveContract(networkKey, "TimelockERC721", timelockERC721Addr, impl721.address);
  saveContract(networkKey, "TimelockERC1155", timelockERC1155Addr, impl1155.address);
  console.log("Updated contract-addresses.json with new implementation addresses.");

  console.log("Done. ETH→token timelocks should now work.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
