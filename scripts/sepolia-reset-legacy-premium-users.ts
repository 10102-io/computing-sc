/**
 * One-shot Sepolia tool: enumerate every historical subscriber of the old
 * PremiumRegistry deployments (v1 proxy + non-upgradeable v2) and call
 * `PremiumSetting.resetPremium(user)` on each so they need to re-subscribe
 * through the current proxy.
 *
 * Why this exists
 * ---------------
 * The Sepolia PremiumRegistry was redeployed on 2026-05-18 as a proper
 * upgradeable proxy at 0xE2433606…04aa70Fb. Subscriber events emitted by
 * the previous deployments aren't indexed by the current subgraph, so the
 * admin's billing list comes up empty even though those users still carry
 * a non-zero `premiumExpired` in PremiumSetting (which was NOT redeployed).
 *
 * Backfilling old events into the subgraph would mean shipping a v0.2.4
 * with an extra Sepolia-only data source pinned at a deprecated address.
 * Forcing re-subscription is cleaner: zero out their state, they hit the
 * dApp once more and the new subgraph indexes that subscription cleanly.
 *
 * Defaults to a dry-run that lists every historical subscriber and their
 * current `premiumExpired` status. Set `EXECUTE=1` to actually call
 * `resetPremium`. Set `INCLUDE_EXPIRED=1` to also reset users whose
 * premium has already lapsed (cosmetic — by default we only reset users
 * with currently-active premium since they're the ones the admin sees
 * as "ghost" subscribers).
 *
 * Run (PowerShell):
 *   npx hardhat run --network sepolia scripts/sepolia-reset-legacy-premium-users.ts
 *   $env:EXECUTE=1; npx hardhat run --network sepolia scripts/sepolia-reset-legacy-premium-users.ts
 *
 * Run (bash):
 *   npx hardhat run --network sepolia scripts/sepolia-reset-legacy-premium-users.ts
 *   EXECUTE=1 npx hardhat run --network sepolia scripts/sepolia-reset-legacy-premium-users.ts
 */
import { ethers, deployments, network } from "hardhat";

/**
 * Old PremiumRegistry addresses on Sepolia. The current canonical
 * PremiumRegistry (0xE243…70Fb) is intentionally NOT scanned — its
 * events ARE indexed by the current subgraph and any subscriber there
 * is already visible to the admin.
 *
 * Sourced from `contract-addresses.json -> sepolia._deprecated`.
 */
const OLD_PREMIUM_REGISTRIES: ReadonlyArray<{ name: string; address: string }> = [
  { name: "PremiumRegistry_v1 (proxy)", address: "0x6495014E1970C8F36Cd4739a6E0b6e836317794d" },
  { name: "PremiumRegistry_nonUpgradeable_v2", address: "0xC3c59ab1a146Da758fEf1f68Bd5F14189e5d0246" },
];

/**
 * PlanSubcribed(address indexed user, uint256, string, uint256) — same
 * signature on every PremiumRegistry version since launch, so a single
 * topic0 catches all historical events.
 */
const PLAN_SUBCRIBED_TOPIC = ethers.utils.id(
  "PlanSubcribed(address,uint256,string,uint256)"
);

/**
 * Pre-deployment lower bound (just before the earliest Sepolia contract
 * in our suite) so the scan covers every PremiumRegistry deployment ever
 * shipped without missing the v1 proxy. Public RPC eth_getLogs allows
 * ~50k-block windows, so we paginate in chunks under that cap.
 */
const SCAN_FROM_BLOCK = 10_400_000;
const SCAN_CHUNK_SIZE = 49_999;

type Row = {
  user: string;
  premiumExpired: bigint;
  status: "active" | "expired" | "never";
};

function envFlag(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function fmtUnix(ts: bigint): string {
  if (ts === 0n) return "n/a";
  const d = new Date(Number(ts) * 1000);
  return d.toISOString();
}

async function main() {
  if (network.name !== "sepolia") {
    throw new Error(
      `This script targets Sepolia only (got network=${network.name}).`
    );
  }

  const dryRun = !envFlag("EXECUTE");
  const includeExpired = envFlag("INCLUDE_EXPIRED");

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  const latestBlock = await ethers.provider.getBlockNumber();

  const psDep = await deployments.get("PremiumSetting");
  const ps = await ethers.getContractAt("PremiumSetting", psDep.address, signer);
  const owner: string = await ps.owner();

  console.log("─".repeat(72));
  console.log(`Network:        ${network.name}`);
  console.log(`Signer:         ${signerAddr}`);
  console.log(`Latest block:   ${latestBlock}`);
  console.log(`PremiumSetting: ${psDep.address}`);
  console.log(`PS owner:       ${owner}`);
  console.log(
    `Mode:           ${dryRun ? "DRY-RUN (set EXECUTE=1 to send tx)" : "EXECUTE"}`
  );
  console.log(
    `Scope:          ${includeExpired ? "all historical subscribers" : "currently-active premium only"}`
  );
  console.log("─".repeat(72));

  if (!dryRun && owner.toLowerCase() !== signerAddr.toLowerCase()) {
    throw new Error(
      `Signer ${signerAddr} is not the PremiumSetting owner (${owner}). ` +
        `resetPremium would revert. Use the admin/deployer key.`
    );
  }

  // ── Phase 1: enumerate every historical subscriber address ──────────────
  const users = new Set<string>();
  for (const reg of OLD_PREMIUM_REGISTRIES) {
    console.log(`\nScanning ${reg.name} @ ${reg.address}`);
    let from = SCAN_FROM_BLOCK;
    let total = 0;
    while (from <= latestBlock) {
      const to = Math.min(from + SCAN_CHUNK_SIZE, latestBlock);
      const logs = await ethers.provider.getLogs({
        address: reg.address,
        topics: [PLAN_SUBCRIBED_TOPIC],
        fromBlock: from,
        toBlock: to,
      });
      total += logs.length;
      for (const log of logs) {
        // topics[1] is the indexed `user` (left-padded to 32 bytes); strip
        // the 12-byte zero pad and re-checksum so we de-dup on canonical form.
        const userHex = "0x" + log.topics[1].slice(26);
        users.add(ethers.utils.getAddress(userHex).toLowerCase());
      }
      from = to + 1;
    }
    console.log(`  events found: ${total}`);
  }

  console.log(`\nUnique historical subscribers: ${users.size}`);
  if (users.size === 0) {
    console.log("Nothing to reset. Exiting.");
    return;
  }

  // ── Phase 2: read current premiumExpired for each user ──────────────────
  const now = BigInt(Math.floor(Date.now() / 1000));
  const rows: Row[] = [];
  for (const u of users) {
    const t = (await ps.premiumExpired(u)).toBigInt() as bigint;
    const status: Row["status"] = t === 0n ? "never" : t > now ? "active" : "expired";
    rows.push({ user: ethers.utils.getAddress(u), premiumExpired: t, status });
  }
  rows.sort((a, b) => Number(b.premiumExpired - a.premiumExpired));

  console.log("\n┌──────────────────────────────────────────┬──────────┬─────────────────────────");
  console.log("│ user                                     │ status   │ premiumExpired (UTC)");
  console.log("├──────────────────────────────────────────┼──────────┼─────────────────────────");
  for (const r of rows) {
    console.log(
      `│ ${r.user} │ ${r.status.padEnd(8)} │ ${fmtUnix(r.premiumExpired)}`
    );
  }
  console.log("└──────────────────────────────────────────┴──────────┴─────────────────────────");

  const counts = {
    active: rows.filter((r) => r.status === "active").length,
    expired: rows.filter((r) => r.status === "expired").length,
    never: rows.filter((r) => r.status === "never").length,
  };
  console.log(
    `\nCounts: active=${counts.active}, expired=${counts.expired}, never-set=${counts.never}`
  );

  // ── Phase 3: filter to the rows we'd actually reset ─────────────────────
  // resetPremium reverts when premiumExpired == 0 ("Not an premium user"),
  // so we always exclude the `never` bucket. By default we also skip
  // already-expired ones since they're not the source of admin confusion.
  const toReset = rows.filter((r) => {
    if (r.premiumExpired === 0n) return false;
    if (!includeExpired && r.status !== "active") return false;
    return true;
  });

  if (toReset.length === 0) {
    console.log("\nNo users match the reset filter. Nothing to do.");
    return;
  }
  console.log(
    `\n${toReset.length} user(s) will be reset${dryRun ? " (DRY-RUN — no tx sent)" : ""}.`
  );

  if (dryRun) {
    console.log("\nRe-run with `EXECUTE=1` to send the resetPremium transactions.");
    return;
  }

  // ── Phase 4: send resetPremium tx for each user ─────────────────────────
  let success = 0;
  for (const r of toReset) {
    try {
      const tx = await ps.resetPremium(r.user);
      const receipt = await tx.wait();
      console.log(
        `  reset ${r.user}  tx=${tx.hash}  gas=${receipt.gasUsed.toString()}`
      );
      success += 1;
    } catch (err) {
      console.warn(
        `  ! ${r.user} failed: ${(err as Error).message ?? String(err)}`
      );
    }
  }
  console.log(`\nDone. ${success}/${toReset.length} resets confirmed.`);

  // Quick post-check: every reset user now reads premiumExpired == 0.
  let mismatched = 0;
  for (const r of toReset) {
    const post = (await ps.premiumExpired(r.user)).toBigInt() as bigint;
    if (post !== 0n) {
      mismatched += 1;
      console.warn(`  ! ${r.user} still has premiumExpired=${post}`);
    }
  }
  if (mismatched === 0) {
    console.log("Verified: every reset user now reads premiumExpired = 0.");
  } else {
    console.warn(`! ${mismatched} user(s) still non-zero — investigate before assuming clean.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
