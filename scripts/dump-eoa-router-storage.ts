import { ethers, deployments, network } from "hardhat";

async function main() {
  const proxy = (await deployments.get("TransferEOALegacyRouter")).address;
  console.log(`Network: ${network.name}`);
  console.log(`Proxy:   ${proxy}`);

  for (let i = 0; i < 20; i++) {
    const v = await ethers.provider.getStorageAt(proxy, i);
    const asAddress = "0x" + v.slice(-40);
    console.log(`slot ${String(i).padStart(2, " ")}: ${v}  (addr: ${asAddress})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
