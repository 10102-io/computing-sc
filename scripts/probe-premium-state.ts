/**
 * Audit the live state of Sepolia's PremiumRegistry + PremiumSetting:
 *  - confirm PremiumSetting.premiumRegistry points at the registry we've
 *    been treating as the wired one
 *  - count plans
 *  - count premium users by scanning `PlanSubcribed` events
 *  - list each unique subscriber + plan + ETH/USDC/USDT method
 *
 * Read-only. Run with: npx hardhat run scripts/probe-sepolia-premium-state.ts --network sepolia
 */
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const c = getContracts()[network.name];
  if (!c) throw new Error(`No section for ${network.name}`);

  const registryAddr = c["PremiumRegistry"].address;
  const settingAddr = c["PremiumSetting"].address;
  console.log(`Network: ${network.name}`);
  console.log(`PremiumRegistry (manifest): ${registryAddr}`);
  console.log(`PremiumSetting  (manifest): ${settingAddr}`);
  console.log("");

  // 1. Confirm PremiumSetting.premiumRegistry points at the manifest entry
  const setting = await ethers.getContractAt("PremiumSetting", settingAddr);
  const wiredRegistry = await setting.premiumRegistry();
  console.log(`PremiumSetting.premiumRegistry = ${wiredRegistry}`);
  const wiredMatchesManifest = wiredRegistry.toLowerCase() === registryAddr.toLowerCase();
  console.log(`  ${wiredMatchesManifest ? "✓ matches manifest" : "✗ MISMATCH — wired registry differs from manifest"}`);
  console.log("");

  // 2. Count plans
  const registry = await ethers.getContractAt("PremiumRegistry", registryAddr);
  const nextPlanId: any = await registry.getNextPlanId();
  console.log(`getNextPlanId() = ${nextPlanId}`);
  console.log(`  → ${Number(nextPlanId)} plan slot(s) allocated total`);

  // PremiumRegistry exposes the plan struct via its public mapping auto-getter:
  //   premiumPlans(i) returns (uint256 usdPrice, uint256 duration, bool isActive)
  // There is no separate getPlan/getPlanStatus view.
  const plans: Array<{ id: number; usdPrice: string; duration: string; isActive: boolean }> = [];
  for (let i = 0; i < Number(nextPlanId); i++) {
    const p: any = await registry.premiumPlans(i);
    plans.push({
      id: i,
      usdPrice: p.usdPrice?.toString?.() ?? p[0]?.toString?.() ?? "?",
      duration: p.duration?.toString?.() ?? p[1]?.toString?.() ?? "?",
      isActive: Boolean(p.isActive ?? p[2]),
    });
  }
  console.log(`Plans (on-chain struct only — name/description/features are event-only):`);
  for (const p of plans) {
    console.log(`  [${p.id}] usdPrice=${p.usdPrice}  duration=${p.duration} (${Math.round(Number(p.duration) / 86400)}d)  isActive=${p.isActive}`);
  }
  console.log("");

  // Pull PlanUpdated events for the plan metadata (name/description/features)
  console.log(`Looking for PlanUpdated events to recover plan metadata…`);
  const planFilter = registry.filters.PlanUpdated();
  const latest0 = await ethers.provider.getBlockNumber();
  const start0 = Math.max(0, latest0 - 864000);
  for (let from = start0; from <= latest0; from += 10000) {
    const to = Math.min(latest0, from + 9999);
    let logs;
    try {
      logs = await registry.queryFilter(planFilter, from, to);
    } catch {
      continue;
    }
    for (const ev of logs) {
      console.log(`  plan=${ev.args?.plan?.toString?.()}  price=${ev.args?.price?.toString?.()}  duration=${ev.args?.duration?.toString?.()}  name="${ev.args?.name}"  description="${ev.args?.description}"  features="${ev.args?.features}"`);
    }
  }
  console.log("");

  // Constructor / initialize args we'd need for a fresh deploy
  console.log(`Init args for a fresh PremiumRegistry deployment:`);
  console.log(`  usdt              = ${await registry.usdt()}`);
  console.log(`  usdc              = ${await registry.usdc()}`);
  console.log(`  usdtUsdPriceFeed  = ${await registry.usdtUsdPriceFeed()}`);
  console.log(`  usdcUsdPriceFeed  = ${await registry.usdcUsdPriceFeed()}`);
  console.log(`  ethUsdPriceFeed   = ${await registry.ethUsdPriceFeed()}`);
  console.log(`  premiumSetting    = ${await registry.premiumSetting()}`);
  console.log(`  payment           = ${await registry.payment()}`);
  console.log("");

  // 3. Scan all PlanSubcribed events
  const filter = registry.filters.PlanSubcribed();
  // Sepolia RPCs typically allow ~5000-block chunks. Scan from a generous
  // starting point — the contract was redeployed in Apr 2026.
  const latest = await ethers.provider.getBlockNumber();
  // Start ~120 days back (Sepolia ≈ 12 sec blocks → 864000 blocks). Cap at chain genesis.
  const startBlock = Math.max(0, latest - 864000);
  console.log(`Scanning PlanSubcribed events from block ${startBlock} → ${latest}…`);

  const chunkSize = 10000;
  const events: Array<{ user: string; plan: number; method: string; amount: string; block: number }> = [];
  for (let from = startBlock; from <= latest; from += chunkSize) {
    const to = Math.min(latest, from + chunkSize - 1);
    let logs;
    try {
      logs = await registry.queryFilter(filter, from, to);
    } catch (e: any) {
      // Some Sepolia RPCs cap range — back off to 1000-block chunks for this window.
      console.log(`  (chunk ${from}-${to} failed: ${e?.message?.slice(0, 60)}, retrying smaller…)`);
      for (let f2 = from; f2 <= to; f2 += 1000) {
        const t2 = Math.min(to, f2 + 999);
        const l2 = await registry.queryFilter(filter, f2, t2);
        for (const ev of l2) {
          events.push({
            user: ev.args?.user,
            plan: Number(ev.args?.plan),
            method: ev.args?.method,
            amount: ev.args?.amount?.toString?.() ?? "?",
            block: ev.blockNumber,
          });
        }
      }
      continue;
    }
    for (const ev of logs) {
      events.push({
        user: ev.args?.user,
        plan: Number(ev.args?.plan),
        method: ev.args?.method,
        amount: ev.args?.amount?.toString?.() ?? "?",
        block: ev.blockNumber,
      });
    }
  }

  console.log(`\nFound ${events.length} PlanSubcribed event(s).`);
  const uniqueSubscribers = new Set(events.map(e => e.user.toLowerCase()));
  console.log(`Unique subscribers: ${uniqueSubscribers.size}`);
  console.log("");
  for (const e of events) {
    console.log(`  block ${e.block}  user=${e.user}  plan=${e.plan}  method=${e.method ?? "(unknown)"}  amount=${e.amount}`);
  }

  // 4. Spot-check premium expiry for each unique subscriber
  console.log(`\nCurrent premium status for each unique subscriber:`);
  for (const u of uniqueSubscribers) {
    const expiry: any = await setting.premiumExpired(u);
    const expiryNum = Number(expiry.toString?.() ?? expiry);
    const now = Math.floor(Date.now() / 1000);
    const stillActive = expiryNum > now;
    const expiryDisplay = expiry.toString?.() ?? String(expiry);
    const isMaxUint = expiryDisplay.length > 70; // MaxUint256 lifetime sentinel
    console.log(`  ${u}  expiry=${isMaxUint ? "(lifetime)" : new Date(expiryNum * 1000).toISOString()}  active=${stillActive}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
