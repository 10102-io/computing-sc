import { ethers, deployments, network } from "hardhat";

async function main() {
  const proxy = (await deployments.get("LegacyDeployer")).address;
  const admin = (await deployments.get("DefaultProxyAdmin")).address;

  console.log(`Network: ${network.name}`);
  console.log(`Proxy:   ${proxy}`);

  const code = await ethers.provider.getCode(proxy);
  console.log(`Code size at proxy: ${(code.length - 2) / 2} bytes`);

  const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dcef62088f0ccdbff21c6a9c7e90d17b9";
  const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

  const implSlot = await ethers.provider.getStorageAt(proxy, EIP1967_IMPL);
  const adminSlot = await ethers.provider.getStorageAt(proxy, EIP1967_ADMIN);
  console.log(`EIP-1967 impl slot:  ${implSlot}`);
  console.log(`EIP-1967 admin slot: ${adminSlot}`);
  console.log(`Expected admin:      ${admin}`);

  // Try asking the admin what impl it thinks the proxy has
  const adminAbi = [
    "function getProxyImplementation(address proxy) view returns (address)",
    "function getProxyAdmin(address proxy) view returns (address)",
  ];
  const adminContract = new ethers.Contract(admin, adminAbi, ethers.provider);
  try {
    const implViaAdmin = await adminContract.getProxyImplementation(proxy);
    console.log(`Admin says impl is:  ${implViaAdmin}`);
  } catch (e: any) {
    console.log(`Admin.getProxyImplementation failed: ${e.message ?? e}`);
  }
  try {
    const adminViaAdmin = await adminContract.getProxyAdmin(proxy);
    console.log(`Admin says admin is: ${adminViaAdmin}`);
  } catch (e: any) {
    console.log(`Admin.getProxyAdmin failed: ${e.message ?? e}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
