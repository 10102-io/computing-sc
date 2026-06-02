/**
 * Read-only on-chain check for the 2nd-round audit follow-ups (Phase B scope).
 *
 * Answers two questions, no state changes, no key required (uses the public
 * mainnet RPC in hardhat.config.ts unless MAINNET_RPC_URL is set):
 *
 *   1. M-2' severity on mainnet:
 *      Is PremiumSetting.transferLegacyContractRouter() == address(0)?
 *      If yes, the onlyLegacy spoof is reachable on mainnet today and we want
 *      the interim mitigation in B-1. If it holds the dormant router address,
 *      M-2' stays purely a fresh-deploy/operator-footgun concern.
 *
 *   2. USDT/USDC SafeERC20 carry-over:
 *      What token sits at PremiumRegistry.usdt()/usdc()? Is usdt classic
 *      Tether (no-bool-return)? Has any PlanSubcribed(method="USDT"/"USDC")
 *      ever emitted on mainnet? Tells us if switching to safeTransferFrom is
 *      a silent fix or a behavior change for live users.
 *
 * Run: npx hardhat run scripts/audit-followup-readonly.ts --network mainnet
 */
import { ethers } from "hardhat";

const ZERO = ethers.constants.AddressZero;
const CLASSIC_TETHER = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // mainnet USDT (no bool return)
const REGISTRY_DEPLOY_BLOCK = 24589602; // from deployments/mainnet/PremiumRegistry.json
const LOG_CHUNK = 45_000; // stay inside common public-node getLogs range caps

const cs = (a: string) => ethers.utils.getAddress(a.toLowerCase());
const ADDR = {
  PremiumSetting: cs("0x5223E0D4D1f0BE6Bf5De7cA6D2Fa9BFB6447013f"),
  PremiumRegistry: cs("0x44Ae934Ef4a30FF11f9665174dDFa9F0c93bEA27"),
};

async function main() {
  const net = await ethers.provider.getNetwork();
  console.log(`Network: chainId=${net.chainId}`);
  if (net.chainId !== 1) {
    console.log("WARNING: expected mainnet (chainId 1). Re-run with --network mainnet.");
  }

  // ── 1. M-2' — sunset router slot ────────────────────────────────────────
  console.log("\n=== M-2': PremiumSetting router slots ===");
  const setting = await ethers.getContractAt("PremiumSetting", ADDR.PremiumSetting);
  const sunset = await setting.transferLegacyContractRouter();
  const eoa = await setting.transferLegacyEOAContractRouter();
  const multi = await setting.multisigLegacyContractRouter();
  console.log(`  transferLegacyContractRouter   = ${sunset}`);
  console.log(`  transferLegacyEOAContractRouter = ${eoa}`);
  console.log(`  multisigLegacyContractRouter   = ${multi}`);
  if (sunset === ZERO) {
    console.log("  >>> SLOT IS address(0): M-2' IS REACHABLE ON MAINNET TODAY.");
    console.log("  >>> Recommend the interim setParams reject-zero mitigation in B-1.");
  } else {
    console.log("  >>> Slot holds a non-zero address: M-2' is NOT reachable on mainnet now");
    console.log("      (only a fresh-deploy / operator-zeroing footgun). B-1 mitigation optional.");
  }

  // ── 2. USDT/USDC token wiring ───────────────────────────────────────────
  console.log("\n=== USDT/USDC: PremiumRegistry token wiring ===");
  const registry = await ethers.getContractAt("PremiumRegistry", ADDR.PremiumRegistry);
  const usdt: string = await registry.usdt();
  const usdc: string = await registry.usdc();
  console.log(`  usdt() = ${usdt}`);
  console.log(`  usdc() = ${usdc}`);
  const isClassicTether = usdt.toLowerCase() === CLASSIC_TETHER.toLowerCase();
  console.log(
    isClassicTether
      ? "  >>> usdt() IS classic mainnet Tether (no bool return): raw transferFrom REVERTS."
      : "  >>> usdt() is NOT classic Tether — confirm whether it returns a bool before concluding."
  );

  // ── 3. Historical PlanSubcribed events (method tally) ───────────────────
  console.log("\n=== PlanSubcribed history (payment-method tally) ===");
  const latest = await ethers.provider.getBlockNumber();
  const tally: Record<string, number> = {};
  const usdtSubs: { user: string; block: number; tx: string }[] = [];
  let scannedOk = true;
  try {
    for (let from = REGISTRY_DEPLOY_BLOCK; from <= latest; from += LOG_CHUNK) {
      const to = Math.min(from + LOG_CHUNK - 1, latest);
      const evs = await registry.queryFilter(registry.filters.PlanSubcribed(), from, to);
      for (const e of evs) {
        const method = String(e.args?.paymentMethod ?? "?");
        tally[method] = (tally[method] ?? 0) + 1;
        if (method.toUpperCase() === "USDT") {
          usdtSubs.push({ user: String(e.args?.user), block: e.blockNumber, tx: e.transactionHash });
        }
      }
    }
  } catch (err: any) {
    scannedOk = false;
    console.log(`  Could not complete log scan via this RPC: ${err.code || err.message}`);
    console.log("  Set MAINNET_RPC_URL to an archive node and re-run for the event tally.");
  }
  if (scannedOk) {
    const methods = Object.keys(tally);
    if (methods.length === 0) {
      console.log("  No PlanSubcribed events found on mainnet (no subscriptions yet).");
    } else {
      for (const m of methods) console.log(`  ${m}: ${tally[m]}`);
    }
    if (usdtSubs.length > 0) {
      console.log("  >>> USDT subscriptions DID succeed on mainnet — SafeERC20 fix is behavior-affecting:");
      for (const s of usdtSubs) console.log(`      user=${s.user} block=${s.block} tx=${s.tx}`);
    } else if (isClassicTether) {
      console.log("  >>> No USDT subscriptions ever — consistent with classic Tether reverting.");
      console.log("      SafeERC20 fix is a SILENT correctness fix (no live users affected).");
    }
  }

  console.log("\nDone. Paste this output into the Phase B doc §7 / the reviewer memo.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
