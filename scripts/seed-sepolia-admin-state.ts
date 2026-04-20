import { ethers } from "hardhat";

// Idempotent seeder: ensures the wired PremiumRegistry has at least the dev penny plan
// and that TokenWhiteList contains the expected tokens. Safe to rerun.

const PREMIUM_REGISTRY = "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246";
const TOKEN_WHITELIST = "0xE7e5011263e862f964F608C26654edAD25497B8F";

const TEST_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const TEST_USDT = "0x02f62735EaF5fFB56B629bC529e72801713f27cd";
// Sepolia WETH9 — same address the UI hardcodes in constants/weth.ts and
// constants/storageTokens.ts. Must match exactly or the ETH auto-swap
// feature in Timelock and EOA Legacy will show an empty token dropdown.
const WETH_SEPOLIA = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
// Sepolia wstETH (Lido)
const WSTETH_SEPOLIA = "0xB82381A3fBD3FaFA77B3a7bE693342618240067b";

const DRY_RUN = process.env.DRY_RUN === "1";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Signer:", await signer.getAddress(), "dryRun:", DRY_RUN);

  // ------- PremiumRegistry: seed penny plan if no plans exist -------
  console.log("\n=== PremiumRegistry ===");
  const registry = await ethers.getContractAt(
    [
      "function getNextPlanId() view returns (uint256)",
      "function premiumPlans(uint256) view returns (uint256,uint256,bool)",
      "function createPlans(uint256[] durations, uint256[] prices, string[] names, string[] descriptions, string[] features) external",
      "function OPERATOR() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
    ],
    PREMIUM_REGISTRY
  );
  const operator = await (registry as any).OPERATOR();
  const hasOp = await (registry as any).hasRole(operator, await signer.getAddress());
  console.log("  signer has OPERATOR:", hasOp);
  const n = Number(await (registry as any).getNextPlanId());
  console.log("  existing plan count:", n);
  for (let i = 0; i < n; i++) {
    const plan = await (registry as any).premiumPlans(i);
    console.log(`    plan[${i}]: usdPrice=${plan[0]} duration=${plan[1]} isActive=${plan[2]}`);
  }
  if (n === 0) {
    console.log("  creating penny plan: $0.01 / 365 days (id=0)");
    if (!DRY_RUN) {
      const tx = await (registry as any).createPlans(
        [365 * 24 * 60 * 60], // durations (seconds)
        [1], // prices x100  → 0.01 USD (schema: usdPrice*100, two digits after decimal)
        ["Dev Penny Plan"],
        ["1-year testnet plan for QA on Sepolia"],
        ["full feature set"]
      );
      console.log("  tx:", tx.hash);
      await tx.wait();
      console.log("  ✓ plan created");
    } else {
      console.log("  (dry-run) skipping write");
    }
  } else {
    console.log("  plans already exist, skipping");
  }

  // ------- TokenWhiteList: ensure tokens present -------
  console.log("\n=== TokenWhiteList ===");
  const whitelist = await ethers.getContractAt(
    [
      "function isWhitelisted(address) view returns (bool)",
      "function getWhitelist() view returns (address[])",
      "function addToken(address) external",
      "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      "function hasRole(bytes32,address) view returns (bool)",
    ],
    TOKEN_WHITELIST
  );
  const role = await (whitelist as any).DEFAULT_ADMIN_ROLE();
  const isAdmin = await (whitelist as any).hasRole(role, await signer.getAddress());
  console.log("  signer has DEFAULT_ADMIN_ROLE:", isAdmin);

  let current: string[] = [];
  try {
    current = await (whitelist as any).getWhitelist();
    console.log(`  getWhitelist returned ${current.length}:`, current.join(", "));
  } catch (e: any) {
    console.log(`  getWhitelist: ${e.message?.slice(0, 80)}`);
  }

  const want: Array<[string, string]> = [
    ["USDC", TEST_USDC],
    ["USDT", TEST_USDT],
    ["WETH", WETH_SEPOLIA],
    ["wstETH", WSTETH_SEPOLIA],
  ];
  for (const [name, addr] of want) {
    let allowed = false;
    try {
      allowed = await (whitelist as any).isWhitelisted(addr);
    } catch {}
    if (allowed) {
      console.log(`  ${name} (${addr}): already whitelisted`);
      continue;
    }
    console.log(`  ${name} (${addr}): adding...`);
    if (!DRY_RUN) {
      try {
        const tx = await (whitelist as any).addToken(addr);
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log(`    ✓ added ${name}`);
      } catch (e: any) {
        console.log(`    ✗ failed ${name}: ${e.message?.slice(0, 160)}`);
      }
    } else {
      console.log("    (dry-run) skipping write");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
