import { ethers } from "hardhat";

const LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
const MANAGER = "0x5B2e634D1a22E74902408EA25D6E221B8A1DfcDE";
const AMOUNT_LINK = "10"; // 10 LINK -> covers ~6-9 cronjob mints + top-ups

async function main() {
  const [signer] = await ethers.getSigners();
  const link = await ethers.getContractAt(
    [
      "function balanceOf(address) view returns (uint256)",
      "function transfer(address,uint256) returns (bool)",
    ],
    LINK,
    signer
  );
  const amount = (ethers as any).utils.parseUnits(AMOUNT_LINK, 18);
  const beforeMgr = await (link as any).balanceOf(MANAGER);
  const beforeMe = await (link as any).balanceOf(await signer.getAddress());
  console.log(
    `Before: deployer=${(ethers as any).utils.formatUnits(
      beforeMe,
      18
    )} LINK, manager=${(ethers as any).utils.formatUnits(beforeMgr, 18)} LINK`
  );

  const tx = await (link as any).transfer(MANAGER, amount, {
    gasPrice: (ethers as any).utils.parseUnits("3", "gwei"),
  });
  console.log(`transfer tx: ${tx.hash}`);
  await tx.wait();

  const afterMgr = await (link as any).balanceOf(MANAGER);
  const afterMe = await (link as any).balanceOf(await signer.getAddress());
  console.log(
    `After:  deployer=${(ethers as any).utils.formatUnits(
      afterMe,
      18
    )} LINK, manager=${(ethers as any).utils.formatUnits(afterMgr, 18)} LINK`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
