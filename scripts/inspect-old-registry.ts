import { ethers } from "hardhat";

// Check if the PremiumRegistry at 0xC3c5...0246 (referenced by OLD PremiumSetting) is
// healthy and whether we already have everything we need without redeploying it.

const OLD_REGISTRY = "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246";
const ORPHAN_REGISTRY = "0x19dc9ea1Af43EcACda2F672769B8D9de27EaD60B";
const OLD_PREMIUM_SETTING = "0xEA267a1F6D554dD416d26c60eFef9234ebfde95e";
const NEW_REGISTRY_V1 = "0x2A2280e3c90F09A3045CEDB95C628DEE58C62361";

const EXPECTED_ADMIN = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";

async function diag(label: string, addr: string) {
  console.log(`\n--- ${label} (${addr}) ---`);
  // Ownable
  try {
    const o = await ethers.getContractAt(
      ["function owner() view returns (address)"],
      addr
    );
    const owner = await (o as any).owner();
    const tag = owner.toLowerCase() === EXPECTED_ADMIN.toLowerCase() ? "YOU" : "OTHER";
    console.log(`  owner: ${owner} [${tag}]`);
  } catch (e: any) {
    console.log(`  owner: UNREADABLE (${e.message?.slice(0, 80)})`);
  }
  // AccessControl DEFAULT_ADMIN_ROLE
  try {
    const c = await ethers.getContractAt(
      [
        "function hasRole(bytes32,address) view returns (bool)",
        "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
      ],
      addr
    );
    const r = await (c as any).DEFAULT_ADMIN_ROLE();
    const h = await (c as any).hasRole(r, EXPECTED_ADMIN);
    console.log(`  DEFAULT_ADMIN_ROLE(you): ${h}`);
  } catch {
    console.log(`  DEFAULT_ADMIN_ROLE: n/a`);
  }
  // Registry-specific fields
  const rSig = [
    "function premiumSetting() view returns (address)",
    "function payment() view returns (address)",
    "function usdt() view returns (address)",
    "function usdc() view returns (address)",
    "function getNextPlanId() view returns (uint256)",
  ];
  try {
    const c = await ethers.getContractAt(rSig, addr);
    const ps = await (c as any).premiumSetting();
    const p = await (c as any).payment();
    const usdt = await (c as any).usdt();
    const usdc = await (c as any).usdc();
    const n = await (c as any).getNextPlanId();
    console.log(`  premiumSetting: ${ps}`);
    console.log(`  payment:        ${p}`);
    console.log(`  usdt:           ${usdt}`);
    console.log(`  usdc:           ${usdc}`);
    console.log(`  next plan id:   ${n}`);
    for (let i = 0; i < Number(n); i++) {
      try {
        const planSig = ["function premiumPlans(uint256) view returns (uint256,uint256,bool)"];
        const p2 = await ethers.getContractAt(planSig, addr);
        const plan = await (p2 as any).premiumPlans(i);
        console.log(`    plan[${i}]: usdPrice=${plan[0]} duration=${plan[1]} isActive=${plan[2]}`);
      } catch {}
    }
  } catch (e: any) {
    console.log(`  registry fields: UNREADABLE (${e.message?.slice(0, 80)})`);
  }
}

async function main() {
  const [s] = await ethers.getSigners();
  console.log("Signer:", await s.getAddress());
  await diag("OLD_REGISTRY (referenced by OLD PremiumSetting)", OLD_REGISTRY);
  await diag("ORPHAN_REGISTRY (old hard-coded address)", ORPHAN_REGISTRY);
  await diag("NEW_REGISTRY_V1 (just deployed)", NEW_REGISTRY_V1);

  // Also check Payment pointed at by OLD_REGISTRY
  console.log("\n--- Check OLD_REGISTRY.payment.getFee() ---");
  try {
    const r = await ethers.getContractAt(
      ["function payment() view returns (address)"],
      OLD_REGISTRY
    );
    const pay = await (r as any).payment();
    const p = await ethers.getContractAt(
      ["function getFee() view returns (uint256)"],
      pay
    );
    const fee = await (p as any).getFee();
    console.log(`  payment ${pay} fee = ${fee}`);
  } catch (e: any) {
    console.log(`  UNREADABLE: ${e.message?.slice(0, 80)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
