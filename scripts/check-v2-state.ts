/** Post-upgrade state preservation check (read-only). */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const contracts = getContracts()[hre.network.name];

  const eoa = await ethers.getContractAt("TransferEOALegacyRouter", contracts["TransferEOALegacyRouter"].address);
  console.log("EOA router:");
  console.log(`  legacyImplementation: ${await eoa.legacyImplementation()}`);
  console.log(`  legacyCounter/nonce probe (getNextLegacyAddress deployer): ${await eoa.getNextLegacyAddress("0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630")}`);

  const tl = await ethers.getContractAt("TimeLockRouter", contracts["TimeLockRouter"].address);
  console.log("TimeLockRouter:");
  console.log(`  timelockCounter:       ${(await tl.timelockCounter()).toString()}`);
  console.log(`  timelockERC20Contract: ${await tl.timelockERC20Contract()}`);
  console.log(`  tokenWhitelist:        ${await tl.tokenWhitelist()}`);
  console.log(`  uniswapRouter:         ${await tl.uniswapRouter()}`);
  console.log(`  owner:                 ${await tl.owner()}`);

  const d = await tl.eip712Domain();
  console.log(`  eip712Domain: name="${d.name}" version="${d.version}" chainId=${d.chainId}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
