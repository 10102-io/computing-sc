import { ethers } from "hardhat";

const LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789";

async function main() {
  const [signer] = await ethers.getSigners();
  const addr = await signer.getAddress();
  const link = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    LINK
  );
  const bal = await (link as any).balanceOf(addr);
  console.log(`Deployer: ${addr}`);
  console.log(
    `Deployer Sepolia LINK: ${(ethers as any).utils.formatUnits(bal, 18)} LINK`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
