/**
 * Adds the configured USDC (from external-addresses) to TokenWhiteList.
 * Required for ETH→USDC swap in timelock creation.
 *
 * Run: yarn add-token-to-whitelist or npx hardhat run deploy/init/3.addTokenToWhitelist.ts --network sepolia
 */

import { DeployFunction } from "hardhat-deploy/dist/types";
import * as dotenv from "dotenv";
import { ethers } from "ethers";
import { network } from "hardhat";

import { getContracts, getExternalAddresses, getProvider } from "../../scripts/utils";

dotenv.config();

async function main(): Promise<void> {
  const contracts = getContracts();
  const whitelistAddr = contracts[network.name]?.TokenWhiteList?.address;
  if (!whitelistAddr) {
    throw new Error(`TokenWhiteList not found for network ${network.name}`);
  }

  const { usdc } = getExternalAddresses(network.name);
  if (!usdc || usdc === "0x0000000000000000000000000000000000000000") {
    throw new Error(`USDC not configured for network ${network.name}`);
  }

  const whitelistAbi = [
    "function isWhitelisted(address token) view returns (bool)",
    "function addToken(address token)",
  ];
  const { wallet } = getProvider();
  const whitelist = new ethers.Contract(whitelistAddr, whitelistAbi, wallet);

  if (await whitelist.isWhitelisted(usdc)) {
    console.log(`USDC ${usdc} is already whitelisted.`);
    return;
  }

  const tx = await whitelist.addToken(usdc);
  console.log(`Added USDC ${usdc} to TokenWhiteList at tx ${tx.hash}`);
  await tx.wait();
  console.log("Done.");
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

const addTokenToWhitelist: DeployFunction = async () => {
  /* Run via: yarn add-token-to-whitelist or npx hardhat run deploy/init/3.addTokenToWhitelist.ts --network <network> */
};
addTokenToWhitelist.tags = ["init", "addTokenToWhitelist"];
addTokenToWhitelist.id = "addTokenToWhitelist";
export default addTokenToWhitelist;
