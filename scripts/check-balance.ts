import { ethers } from "hardhat";

async function main() {
  const [s] = await ethers.getSigners();
  const b = await ethers.provider.getBalance(s.address);
  console.log("Address:", s.address);
  console.log("Balance:", ethers.utils.formatEther(b), "ETH");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
