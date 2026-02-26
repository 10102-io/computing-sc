import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Deployer:", signer.address);

  const abi = [
    "function setParams(address _premiumRegistry, address _transferLegacyContractRouter, address _transferLegacyEOAContractRouter, address _multisigLegacyContractRouter) external",
  ];
  const ps = new ethers.Contract("0x3bCdDC531215a67144bB30959b86311E10DfB81d", abi, signer as any);

  const tx = await ps.setParams(
    "0xc4ea3B86d16d4d8D8a929e6a20B7E533BC134958", // premiumRegistry (unchanged)
    "0x33dAc5303C3c1309Fe98aBC151C987A6EEF9D9bC", // transferLegacyContractRouter (unchanged)
    "0xd4FF1FA9FA258a45aF5296B88Ed7e97233A7FE65", // transferLegacyEOAContractRouter (NEW)
    "0x8D795B12E45c020484edF4a7B37B0B14912bb644", // multisigLegacyContractRouter (unchanged)
  );
  console.log("tx:", tx.hash);
  await tx.wait();
  console.log("Done. PremiumSetting.transferLegacyEOAContractRouter updated.");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
