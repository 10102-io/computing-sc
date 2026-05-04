/**
 * Quick read-only snapshot of current mainnet gas conditions to help estimate
 * the cost of the EIP-1167 deploy sequence before signing anything.
 */
import { ethers, network } from "hardhat";

async function main() {
  const block = await ethers.provider.getBlock("latest");
  const baseFee = block.baseFeePerGas;
  if (!baseFee) {
    console.log("No baseFeePerGas on this block (pre-EIP-1559 or local chain)");
    return;
  }

  const baseFeeGwei = Number(baseFee) / 1e9;

  console.log(`Network:      ${network.name}`);
  console.log(`Latest block: ${block.number}`);
  console.log(`baseFee:      ${baseFeeGwei.toFixed(3)} gwei`);

  // Assume a 0.1 gwei priority tip (what the UI's gas override aims for)
  const priorityTipGwei = 0.1;
  const totalGwei = baseFeeGwei + priorityTipGwei;
  console.log(`priority tip: ${priorityTipGwei} gwei (assumed — UI clamps to this)`);
  console.log(`total:        ${totalGwei.toFixed(3)} gwei`);

  // Published on 2025-12: ETH ≈ $3000 baseline; the user can eyeball current
  const ethUsd = 3000;
  console.log(`\nEstimated cost at ETH = $${ethUsd}:\n`);

  const steps = [
    { name: "Step 2 · LegacyDeployer upgrade",      gas: 2_000_000 },
    { name: "Step 3 · Router upgradeAndCall+impl",   gas: 5_000_000 },
    { name: "Step 4 · Clone impl + setImpl",         gas: 4_000_000 },
  ];

  let total = 0;
  for (const s of steps) {
    const costEth = (s.gas * totalGwei) / 1e9;
    const costUsd = costEth * ethUsd;
    total += s.gas;
    console.log(`  ${s.name.padEnd(42)} ~${(s.gas / 1e6).toFixed(1)}M gas  ≈  $${costUsd.toFixed(2)}`);
  }
  const totalEth = (total * totalGwei) / 1e9;
  console.log(`  ${"TOTAL (steps 2–4)".padEnd(42)} ~${(total / 1e6).toFixed(1)}M gas  ≈  $${(totalEth * ethUsd).toFixed(2)}`);
  console.log(`                                              (${totalEth.toFixed(4)} ETH)`);

  // What a post-deploy EOA legacy creation will cost vs. the old path
  console.log(`\nOngoing (user-facing) cost per new EOA legacy AFTER this deploy:`);
  const cloneGas = 1_100_000;
  const fullGas = 6_000_000;
  const cloneCost = (cloneGas * totalGwei) / 1e9 * ethUsd;
  const fullCost = (fullGas * totalGwei) / 1e9 * ethUsd;
  console.log(`  Clone path (new):      ${(cloneGas / 1e6).toFixed(1)}M gas  ≈  $${cloneCost.toFixed(2)}`);
  console.log(`  Full bytecode (old):   ${(fullGas / 1e6).toFixed(1)}M gas   ≈  $${fullCost.toFixed(2)}`);
  console.log(`  Savings per legacy:                    ≈  $${(fullCost - cloneCost).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
