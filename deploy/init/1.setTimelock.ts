import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { network } from "hardhat";

dotenv.config();

import * as fs from "fs";
import { getContracts, getProvider } from "../../scripts/utils";

async function main() {
  const contracts = getContracts();
  const timelock = contracts[network.name]["TimeLockRouter"].address;
  const timelockERC20 = contracts[network.name]["TimelockERC20"].address;
  const timelockERC721 =  contracts[network.name]["TimelockERC721"].address;
  const timelockERC1155 = contracts[network.name]["TimelockERC1155"].address;

  const timelockRouter = JSON.parse(fs.readFileSync("./artifacts/contracts/timelock/TimeLockRouter.sol/TimeLockRouter.json", "utf-8")).abi;

  const { provider, wallet } = getProvider();
  const timelockRouterIns = new ethers.Contract(timelock, timelockRouter, wallet);

  const data = await timelockRouterIns.setTimelock(timelockERC20, timelockERC721, timelockERC1155);

  console.log(`Set timelock at tx ${data.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
