import { DeployFunction } from "hardhat-deploy/dist/types";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { network } from "hardhat";

dotenv.config();

import * as fs from "fs";
import { getContracts, getProvider } from "../../scripts/utils";

async function main() {
  const contracts = getContracts();
  const timelockRouterAddr = contracts[network.name]["TimeLockRouter"]?.address;
  const tokenWhitelistAddr = contracts[network.name]["TokenWhiteList"]?.address;

  if (!timelockRouterAddr) {
    throw new Error(`TimeLockRouter not found for network ${network.name}`);
  }
  if (!tokenWhitelistAddr) {
    throw new Error(`TokenWhiteList not found for network ${network.name}`);
  }

  const abi = JSON.parse(
    fs.readFileSync("./artifacts/contracts/timelock/TimeLockRouter.sol/TimeLockRouter.json", "utf-8")
  ).abi;

  const { wallet } = getProvider();
  const timelockRouter = new ethers.Contract(timelockRouterAddr, abi, wallet);

  const tx = await timelockRouter.setTokenWhitelist(tokenWhitelistAddr);
  console.log(`Set token whitelist on TimeLockRouter at tx ${tx.hash}`);
  await tx.wait();
  console.log("Done.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

const setTokenWhitelist: DeployFunction = async () => {
  /* Run via: npx hardhat run deploy/init/1b.setTokenWhitelistOnRouter.ts --network <network> */
};
setTokenWhitelist.tags = ["init", "setTokenWhitelist"];
setTokenWhitelist.id = "setTokenWhitelist";
export default setTokenWhitelist;
