/**
 * B2B premium batch grant — Bet 3 of `computing/docs/plans/b2b.md`.
 *
 * Grants an existing PremiumRegistry plan to a list of addresses via
 * `subrcribeByAdmin` (OPERATOR-gated; the signer must hold the OPERATOR
 * role on the registry). Used for employer/partner seat packages: the
 * company pays off-chain (invoice), we grant seats on-chain. Nothing
 * custodial happens here — a grant only extends `premiumExpired` in
 * PremiumSetting for each user.
 *
 * Usage:
 *   npx hardhat run scripts/grant-premium-batch.ts --network mainnet
 *
 * Env (set inline or in .env):
 *   GRANT_CSV     path to a CSV file, one 0x address per line
 *                 (comments with # and blank lines are skipped)
 *   GRANT_PLAN    numeric plan id in PremiumRegistry (must be active)
 *   GRANT_METHOD  free-text attribution recorded in the PlanSubcribed
 *                 event, e.g. "b2b:acme-2026" — this is how the partner
 *                 shows up in computing-admin's users-billings reporting,
 *                 so keep the "b2b:<partner-slug>" convention.
 *   GRANT_DRY_RUN "false" to actually send; anything else = dry run.
 *
 * Idempotency: `updatePremiumTime` extends from the later of now/current
 * expiry, so re-running a partially-completed batch would extend already
 * granted users again. The script therefore SKIPS addresses whose
 * current premiumExpired is later than (now + duration - 7 days), which
 * makes re-runs safe.
 */
import * as fs from "node:fs";

import { ethers } from "hardhat";

import contractAddresses from "../contract-addresses.json";

const DAY = 86400;

async function main() {
  const csvPath = process.env.GRANT_CSV;
  const planId = process.env.GRANT_PLAN;
  const method = process.env.GRANT_METHOD;
  const dryRun = process.env.GRANT_DRY_RUN !== "false";

  if (!csvPath || planId === undefined || !method) {
    throw new Error(
      'Set GRANT_CSV (address list), GRANT_PLAN (plan id) and GRANT_METHOD ("b2b:<partner>")'
    );
  }
  if (!/^b2b:[a-z0-9-]+/.test(method)) {
    console.warn(
      `[warn] GRANT_METHOD "${method}" does not follow the "b2b:<partner-slug>" convention — reporting joins on this string.`
    );
  }

  const network = await ethers.provider.getNetwork();
  const netKey = network.chainId === 1 ? "mainnet" : "sepolia";
  const addrs = (
    contractAddresses as unknown as Record<
      string,
      Record<string, { address: string }>
    >
  )[netKey];
  const registryAddr = addrs["PremiumRegistry"].address;
  const settingAddr = addrs["PremiumSetting"].address;

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  console.log(`network=${netKey} registry=${registryAddr} signer=${signerAddr}`);

  const registry = await ethers.getContractAt("PremiumRegistry", registryAddr);
  const setting = await ethers.getContractAt("PremiumSetting", settingAddr);

  // Fail fast on role/plan problems before touching the list.
  const OPERATOR = await registry.OPERATOR();
  if (!(await registry.hasRole(OPERATOR, signerAddr))) {
    throw new Error("Signer does not hold OPERATOR on PremiumRegistry");
  }
  const duration = await registry.getPlanDuration(planId); // BigNumber (seconds)
  console.log(
    `plan=${planId} duration=${duration.toString()}s (~${duration.toNumber() / DAY} days)`
  );

  const users = fs
    .readFileSync(csvPath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const invalid = users.filter((u) => !ethers.utils.isAddress(u));
  if (invalid.length > 0) {
    throw new Error(`Invalid addresses in CSV: ${invalid.join(", ")}`);
  }

  const now = Math.floor(Date.now() / 1000);
  // Re-run safety threshold: already covered by (approximately) this grant.
  const threshold = duration.add(now).sub(7 * DAY);
  let granted = 0;
  let skipped = 0;
  for (const raw of users) {
    const user = ethers.utils.getAddress(raw);
    const expiry = await setting.premiumExpired(user); // BigNumber (unix)
    if (expiry.gt(threshold)) {
      console.log(
        `skip  ${user} (premium until ${new Date(expiry.toNumber() * 1000).toISOString()})`
      );
      skipped++;
      continue;
    }
    if (dryRun) {
      console.log(`would grant ${user} plan=${planId} method=${method}`);
      granted++;
      continue;
    }
    const tx = await registry.subrcribeByAdmin(user, planId, method);
    await tx.wait();
    console.log(`grant ${user} tx=${tx.hash}`);
    granted++;
  }
  console.log(
    `${dryRun ? "[dry-run] " : ""}done: ${granted} granted, ${skipped} skipped, ${users.length} total`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
