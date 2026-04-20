import { ethers } from "hardhat";

async function main() {
  const [s] = await ethers.getSigners();
  const latest = await ethers.provider.getTransactionCount(s.address, "latest");
  const pending = await ethers.provider.getTransactionCount(s.address, "pending");
  const balance = await ethers.provider.getBalance(s.address);
  console.log("Address:        ", s.address);
  console.log("Balance:        ", ethers.utils.formatEther(balance), "ETH");
  console.log("Latest nonce:   ", latest);
  console.log("Pending nonce:  ", pending);
  console.log("Has pending tx: ", pending !== latest ? "YES (" + (pending - latest) + " stuck)" : "no");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
