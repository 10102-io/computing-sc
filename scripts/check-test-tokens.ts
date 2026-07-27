/** Which Sepolia test token can the deployer actually use? (read-only) */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const [deployer] = await ethers.getSigners();
  const contracts = getContracts()[hre.network.name];
  for (const name of ["ERC20Token_USDT", "ERC20Token_USDC"]) {
    const t = await ethers.getContractAt("ERC20Token", contracts[name].address);
    const [bal, dec, owner] = await Promise.all([
      t.balanceOf(deployer.address),
      t.decimals(),
      t.owner().catch(() => "(no owner fn)"),
    ]);
    console.log(`${name} @ ${contracts[name].address}`);
    console.log(`  decimals=${dec} owner=${owner}`);
    console.log(`  deployer balance=${ethers.utils.formatUnits(bal, dec)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
