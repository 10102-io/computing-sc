/**
 * Mint the public-mint QA token (R2USD) to QA wallets on Sepolia.
 *
 * Why: the asset picker only shows whitelisted ERC-20s the wallet actually
 * holds, and the legacy test USDC/USDT have owner-gated mint with keys we
 * don't control — so QA wallets see "only ETH". R2USD (LegacyToken) has a
 * public mint; this tops up wallets so token flows are testable.
 *
 * Usage:
 *   # explicit recipient(s), comma-separated:
 *   $env:TO="0xabc...,0xdef..."; npx hardhat run scripts/mint-qa-tokens.ts --network sepolia
 *
 *   # or auto-detect: mints to the creators of the most recent
 *   # TransferEOALegacyCreatedV2 events on the EOA router.
 *   npx hardhat run scripts/mint-qa-tokens.ts --network sepolia
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

const AMOUNT = ethers.utils.parseUnits("10000", 18);

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const contracts = getContracts()[network];
  if (!contracts) throw new Error(`No contract addresses for "${network}"`);

  const tokenAddr = contracts["ERC20Token_R2USD"]?.address;
  if (!tokenAddr) throw new Error("ERC20Token_R2USD not deployed on this network");
  const token = await ethers.getContractAt("LegacyToken", tokenAddr);

  let recipients: string[] = (process.env.TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ethers.utils.isAddress(s));

  if (recipients.length === 0) {
    const routerAddr = contracts["TransferEOALegacyRouter"]?.address;
    if (!routerAddr) throw new Error("TransferEOALegacyRouter address not found");
    const topic = ethers.utils.id(
      "TransferEOALegacyCreatedV2(uint256,address,address,(address,uint256)[],(uint256,uint256,uint256),uint256)"
    );
    const latest = await ethers.provider.getBlockNumber();
    // The RPC caps getLogs at 10k-block ranges; scan the last ~50k blocks
    // (about a week of Sepolia — the v2 router is only days old) in chunks.
    const CHUNK = 10000;
    const from = Math.max(0, latest - 5 * CHUNK);
    const logs: Awaited<ReturnType<typeof ethers.provider.getLogs>> = [];
    for (let start = from; start <= latest; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, latest);
      logs.push(
        ...(await ethers.provider.getLogs({
          address: routerAddr,
          topics: [topic],
          fromBlock: start,
          toBlock: end,
        }))
      );
    }
    // creator is the 3rd indexed param (topics[3]).
    recipients = [...new Set(logs.map((l) => ethers.utils.getAddress("0x" + l.topics[3].slice(26))))];
    console.log(`Auto-detected ${recipients.length} v2 creator(s) from ${logs.length} event(s).`);
  }

  if (recipients.length === 0) throw new Error("No recipients (set TO=0x... or create a v2 legacy first)");

  const symbol = await token.symbol();
  for (const to of recipients) {
    const before = await token.balanceOf(to);
    const tx = await token.mint(to, AMOUNT);
    await tx.wait(1);
    const after = await token.balanceOf(to);
    console.log(
      `Minted ${ethers.utils.formatUnits(AMOUNT, 18)} ${symbol} to ${to} ` +
        `(balance ${ethers.utils.formatUnits(before, 18)} -> ${ethers.utils.formatUnits(after, 18)}), tx ${tx.hash}`
    );
  }

  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`Token:    ${tokenAddr} (${symbol}, public mint)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
