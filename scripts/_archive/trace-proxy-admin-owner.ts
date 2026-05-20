import { ethers, network } from "hardhat";

// Read current owner of the mainnet DefaultProxyAdmin and scan for all
// OwnershipTransferred events since its creation.

const PROXY_ADMIN = "0xA41299408EB78D67B9b599e38E3259C11A005145";

async function main() {
  if (network.name !== "mainnet") throw new Error("mainnet-only");

  const admin = new ethers.Contract(
    PROXY_ADMIN,
    [
      "function owner() view returns (address)",
      "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
    ],
    ethers.provider
  );

  const currentOwner = await admin.owner();
  console.log(`DefaultProxyAdmin:         ${PROXY_ADMIN}`);
  console.log(`owner() right now:         ${currentOwner}`);

  const filter = admin.filters.OwnershipTransferred();
  const latest = await ethers.provider.getBlockNumber();
  // Start scan from March 2026 (proxy creation timeframe)
  const logs = await admin.queryFilter(filter, 24500000, latest);
  console.log(`\nOwnershipTransferred events (${logs.length}):`);
  for (const log of logs) {
    const block = await ethers.provider.getBlock(log.blockNumber);
    const date = new Date(block.timestamp * 1000).toISOString();
    const tx = await ethers.provider.getTransaction(log.transactionHash);
    console.log(
      `  block ${log.blockNumber} (${date})  ${log.args?.previousOwner} -> ${log.args?.newOwner}  tx=${log.transactionHash}  from=${tx?.from}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
