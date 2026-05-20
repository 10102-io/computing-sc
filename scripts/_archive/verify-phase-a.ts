/**
 * End-to-end on-chain verification that every Phase A security fix
 * actually landed on Sepolia. Read-only; safe to re-run.
 *
 * Checks:
 *   C-1   TransferEOALegacy clone impl exposes MAX_TRANSFER == 100
 *   H-2   Both routers declare the PrivateCodeSetupNotCompleted event
 *   M-1   PremiumRegistry source on Etherscan uses .call (no .transfer)
 *         (we don't introspect bytecode; the test suite already covers
 *          behavioral M-1, this just confirms the new impl is wired)
 *   plan  Plan 0 is on the new registry with expected params
 *   wire  PremiumSetting.premiumRegistry points at the new proxy
 *   wire  PremiumSetting.transferLegacyContractRouter is address(0)
 *
 * Usage: npx hardhat run scripts/verify-phase-a-sepolia.ts --network sepolia
 */
import { ethers, deployments, network } from "hardhat";

async function main() {
  console.log(`Network: ${network.name}`);

  const registryAddr = (await deployments.get("PremiumRegistry")).address;
  const settingAddr = (await deployments.get("PremiumSetting")).address;
  const eoaRouterAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  const multisigRouterAddr = (await deployments.get("MultisigLegacyRouter")).address;

  const registry = await ethers.getContractAt("PremiumRegistry", registryAddr);
  const setting = await ethers.getContractAt("PremiumSetting", settingAddr);
  const eoaRouter = await ethers.getContractAt("TransferEOALegacyRouter", eoaRouterAddr);

  // ── C-1: MAX_TRANSFER on the live clone impl ───────────────────────────
  const cloneImpl: string = await eoaRouter.legacyImplementation();
  const cloneAtFactory = await ethers.getContractFactory("TransferEOALegacy");
  const cloneAttached = cloneAtFactory.attach(cloneImpl);
  const maxTransfer = await cloneAttached.MAX_TRANSFER();
  const c1Ok = maxTransfer.toString() === "100";
  console.log(`\n[C-1] TransferEOALegacy.MAX_TRANSFER = ${maxTransfer.toString()}  ${c1Ok ? "✓" : "✗ expected 100"}`);
  console.log(`      clone impl: ${cloneImpl}`);

  // ── H-2: PrivateCodeSetupNotCompleted event in both routers ────────────
  // ethers v5: try-catch the event filter; presence means the ABI declares it.
  const h2EOA = (() => { try { eoaRouter.filters.PrivateCodeSetupNotCompleted(); return true; } catch { return false; }})();
  const multisigRouter = await ethers.getContractAt("MultisigLegacyRouter", multisigRouterAddr);
  const h2Multi = (() => { try { multisigRouter.filters.PrivateCodeSetupNotCompleted(); return true; } catch { return false; }})();
  console.log(`\n[H-2] EOA router declares PrivateCodeSetupNotCompleted:       ${h2EOA ? "✓" : "✗"}`);
  console.log(`      Multisig router declares PrivateCodeSetupNotCompleted:  ${h2Multi ? "✓" : "✗"}`);

  // ── M-1: PremiumRegistry impl is the new one ───────────────────────────
  const expectedRegImpl = (await deployments.get("PremiumRegistry_Implementation")).address;
  const adminAddr = (await deployments.get("DefaultProxyAdmin")).address;
  const admin = new ethers.Contract(
    adminAddr,
    ["function getProxyImplementation(address) view returns (address)"],
    ethers.provider,
  );
  const actualRegImpl: string = await admin.getProxyImplementation(registryAddr);
  const m1Ok = actualRegImpl.toLowerCase() === expectedRegImpl.toLowerCase();
  console.log(`\n[M-1] PremiumRegistry impl (chain):    ${actualRegImpl}`);
  console.log(`      PremiumRegistry impl (artifact): ${expectedRegImpl}  ${m1Ok ? "✓ match" : "✗ MISMATCH"}`);

  // ── Plan 0 sanity check (Sepolia-specific) ──────────────────────────────
  // Mainnet has its own pre-existing plan catalog (which Phase A did not
  // touch); only Sepolia's plan 0 was recreated by this rollout and has
  // exact expected metadata. On other networks, we just dump the current
  // catalog as informational output without asserting.
  let planOk = true;
  const planCount = await registry.getNextPlanId();
  if (network.name === "sepolia") {
    const plan0: any = await registry.premiumPlans(0);
    planOk = planCount.toString() === "1" &&
      plan0.usdPrice.toString() === "1" &&
      plan0.duration.toString() === "31536000" &&
      Boolean(plan0.isActive);
    console.log(`\nPlan 0 on new registry (Sepolia recreation):`);
    console.log(`  count        = ${planCount}  ${planCount.toString() === "1" ? "✓" : "✗"}`);
    console.log(`  usdPrice     = ${plan0.usdPrice}  ${plan0.usdPrice.toString() === "1" ? "✓" : "✗"}`);
    console.log(`  duration     = ${plan0.duration}  ${plan0.duration.toString() === "31536000" ? "✓" : "✗"}`);
    console.log(`  isActive     = ${plan0.isActive}  ${plan0.isActive ? "✓" : "✗"}`);
  } else {
    console.log(`\nPlan catalog on ${network.name} (informational, not asserted):`);
    console.log(`  getNextPlanId() = ${planCount}`);
    for (let i = 0; i < Number(planCount); i++) {
      const p: any = await registry.premiumPlans(i);
      const usd = (Number(p.usdPrice) / 100).toFixed(2);
      const days = Math.round(Number(p.duration) / 86400);
      const dur = p.duration.toString() === ethers.constants.MaxUint256.toString()
        ? "lifetime"
        : `${days}d`;
      console.log(`  [${i}] $${usd}  ${dur}  isActive=${p.isActive}`);
    }
  }

  // ── PremiumSetting wiring ───────────────────────────────────────────────
  const wiredRegistry: string = await setting.premiumRegistry();
  const wiredTransferLegacy: string = await setting.transferLegacyContractRouter();
  const wiredOk = wiredRegistry.toLowerCase() === registryAddr.toLowerCase() &&
    wiredTransferLegacy === ethers.constants.AddressZero;
  console.log(`\nPremiumSetting wiring:`);
  console.log(`  premiumRegistry              = ${wiredRegistry}  ${wiredRegistry.toLowerCase() === registryAddr.toLowerCase() ? "✓" : "✗"}`);
  console.log(`  transferLegacyContractRouter = ${wiredTransferLegacy}  ${wiredTransferLegacy === ethers.constants.AddressZero ? "✓ sunset" : "✗ should be 0x0"}`);

  const allOk = c1Ok && h2EOA && h2Multi && m1Ok && planOk && wiredOk;
  console.log(`\n==================================================`);
  console.log(`Phase A on ${network.name}: ${allOk ? "ALL CHECKS PASS ✓" : "FAILURES — see above"}`);
  console.log(`==================================================`);
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
