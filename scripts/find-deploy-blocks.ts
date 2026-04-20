import { ethers } from "hardhat";

// Binary-search-style fetcher for contract creation blocks on Sepolia. We don't have
// Etherscan here, so binary-search `eth_getCode(addr, blockTag)` to find the earliest
// block where the contract has code.

const ADDRESSES: Record<string, string> = {
  WIRED_Payment: "0xd4bf99da7fBcb0A2Fd80754cB5CC9c7CDc9e8D78",
  WIRED_TokenWhiteList: "0xE7e5011263e862f964F608C26654edAD25497B8F",
  WIRED_PremiumRegistry: "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246",
  WIRED_USDC: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  WIRED_USDT: "0x02f62735EaF5fFB56B629bC529e72801713f27cd",
  NEW_Banner: "0x9055140Be419cC91e3C48EA005658D1D11C245b7",
};

async function hasCodeAt(addr: string, block: number): Promise<boolean> {
  const code = await (ethers.provider as any).getCode(addr, block);
  return code && code !== "0x";
}

async function creationBlock(addr: string, low: number, high: number): Promise<number> {
  // Verify tip has code
  if (!(await hasCodeAt(addr, high))) return -1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (await hasCodeAt(addr, mid)) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}

async function main() {
  const latest = await ethers.provider.getBlockNumber();
  console.log("latest block:", latest);
  for (const [name, addr] of Object.entries(ADDRESSES)) {
    const hi = latest;
    // pick a reasonable low — 0 for brand new, or heuristically back off
    const cb = await creationBlock(addr, 0, hi);
    console.log(`${name.padEnd(28)} ${addr} creationBlock=${cb}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
