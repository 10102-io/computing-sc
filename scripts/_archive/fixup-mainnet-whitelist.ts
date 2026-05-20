/**
 * One-shot mainnet fixup: the 2026-05-18 deploy rotated TimeLockRouter's
 * tokenWhitelist pointer to a fresh contract that 4c.SetTimelockSwapRouter
 * pre-loaded with USDC + USDT only. Restore parity with the previous
 * whitelist by adding WETH and stETH so the Timelock UI's token list
 * does not regress.
 *
 * Tokens previously whitelisted on old TokenWhiteList
 * (0x72b6AD53533a618A6Fdc07d8D1b8A3C980F21993):
 *   USDC  0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  ✓ already added
 *   USDT  0xdAC17F958D2ee523a2206206994597C13D831ec7  ✓ already added
 *   WETH  0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2  ✗ needs add
 *   stETH 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84  ✗ needs add
 *   cbETH 0xBe9895146f7AF43049ca1c1AE358B0541Ea49704  ✗ explicitly removed before; do not re-add
 */
import { ethers, network } from "hardhat";

const NEW_WHITELIST = "0x7812777A23877159861d3De567DD97f9d9f64FE9";

const MISSING: { symbol: string; address: string }[] = [
  { symbol: "WETH",  address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
  { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
];

const ABI = [
  "function addToken(address)",
  "function isWhitelisted(address) view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

async function main() {
  if (network.name !== "mainnet") {
    throw new Error(`Refusing to run on ${network.name}; mainnet only`);
  }
  const [signer] = await ethers.getSigners();
  console.log(`Signer: ${await signer.getAddress()}`);
  console.log(`TokenWhiteList: ${NEW_WHITELIST}`);

  const wl = new ethers.Contract(NEW_WHITELIST, ABI, signer as any);
  const adminRole = await wl.DEFAULT_ADMIN_ROLE();
  const hasRole = await wl.hasRole(adminRole, await signer.getAddress());
  console.log(`hasRole(DEFAULT_ADMIN_ROLE, signer) = ${hasRole}`);
  if (!hasRole) throw new Error("Signer lacks DEFAULT_ADMIN_ROLE on the whitelist");

  for (const t of MISSING) {
    const already = await wl.isWhitelisted(t.address);
    if (already) {
      console.log(`  ${t.symbol} already whitelisted ✓`);
      continue;
    }
    console.log(`  adding ${t.symbol} (${t.address})…`);
    const tx = await wl.addToken(t.address);
    const receipt = await tx.wait();
    console.log(`    tx ${tx.hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()})`);
  }

  console.log(`\nFinal verification:`);
  for (const t of MISSING) {
    const ok = await wl.isWhitelisted(t.address);
    console.log(`  ${t.symbol}: ${ok ? "✓" : "✗"}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
