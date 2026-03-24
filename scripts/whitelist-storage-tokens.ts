/**
 * Adds storage tokens to the TokenWhiteList contract.
 * Storage tokens are the hard-coded set of tokens that ETH can be swapped into
 * via the auto-swap feature (Timelock and EOA Legacy).
 *
 * Mainnet tokens: WETH, stETH, cbETH
 * Sepolia tokens: WETH
 *
 * Run:
 *   npx hardhat run scripts/whitelist-storage-tokens.ts --network mainnet
 *   npx hardhat run scripts/whitelist-storage-tokens.ts --network sepolia
 */
import { network, ethers } from "hardhat";
import { getContracts } from "./utils";

const STORAGE_TOKENS: Record<string, { symbol: string; address: string }[]> = {
  mainnet: [
    { symbol: "WETH",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
    { symbol: "cbETH", address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704" },
  ],
  sepolia: [
    { symbol: "WETH",  address: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" },
  ],
};

async function main() {
  const contracts = getContracts()[network.name];
  if (!contracts) throw new Error(`No contracts for network ${network.name}`);

  const tokens = STORAGE_TOKENS[network.name];
  if (!tokens) throw new Error(`No storage token list defined for network "${network.name}"`);

  const [signer] = await ethers.getSigners();
  console.log("Signer: ", signer.address);
  console.log("Network:", network.name);

  const tokenWhiteListAddr = contracts.TokenWhiteList?.address;
  if (!tokenWhiteListAddr) throw new Error("TokenWhiteList not found in contract-addresses.json");

  console.log("TokenWhiteList:", tokenWhiteListAddr);

  const tokenWhiteList = await ethers.getContractAt("TokenWhiteList", tokenWhiteListAddr);

  for (const { symbol, address } of tokens) {
    const already = await (tokenWhiteList as any).isWhitelisted(address);
    if (already) {
      console.log(`  ${symbol} (${address}) already whitelisted — skipping`);
      continue;
    }
    const tx = await (tokenWhiteList as any).addToken(address);
    await tx.wait();
    console.log(`  Added ${symbol} (${address}), tx: ${tx.hash}`);
  }

  console.log("\nVerifying final whitelist...");
  const list: string[] = await (tokenWhiteList as any).getWhitelist();
  console.log("  Whitelisted tokens:", list);

  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
