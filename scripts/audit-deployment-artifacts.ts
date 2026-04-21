/**
 * Audit `deployments/<network>/*.json` for hand-patched or stale artifacts
 * that have bitten us before (see DEFERRED.md → "computing-sc/deployments/*
 * artifact hygiene"). Checks per network:
 *
 *   1) Every `<Name>_Implementation.json` has a `transactionHash` and an
 *      `address`. Missing `transactionHash` is the specific failure mode
 *      that caused hardhat-deploy to refuse the Sepolia clone-refactor
 *      upgrade with "no transaction details found ... please delete the
 *      file".
 *
 *   2) `<Name>.json.implementation` equals `<Name>_Implementation.json.address`
 *      (case-insensitive). If they diverge, hardhat-deploy's view of the
 *      current impl disagrees with the latest Implementation artifact.
 *
 *   3) `<Name>.json.address` equals `<Name>_Proxy.json.address` for every
 *      transparent proxy. Any divergence is a sign someone edited one but
 *      not the other.
 *
 *   4) Optional on-chain cross-check (set `--onchain`): for each proxy,
 *      read EIP-1967 implementation slot
 *      (0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)
 *      and compare to the artifact's `implementation` field.
 *
 * Run:
 *   npx hardhat run scripts/audit-deployment-artifacts.ts
 *   npx hardhat run --network <net> scripts/audit-deployment-artifacts.ts
 *
 * When invoked with a non-hardhat network (mainnet, sepolia), the on-chain
 * cross-check runs automatically for that network.
 *
 * Read-only. Never modifies deployments/** files.
 */
import fs from "fs";
import path from "path";
import { ethers, network } from "hardhat";

const DEPLOYMENTS_ROOT = path.join("deployments");
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type Issue = {
  artifact: string;
  severity: "error" | "warn" | "info";
  message: string;
};

function readJson(p: string): Record<string, unknown> | null {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch (e) {
    return null;
  }
}

function eqAddr(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return a.toLowerCase() === b.toLowerCase();
}

async function auditNetwork(
  net: string,
  opts: { onchain: boolean }
): Promise<Issue[]> {
  const dir = path.join(DEPLOYMENTS_ROOT, net);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const issues: Issue[] = [];

  // Group files by base name: "Foo", "Foo_Implementation", "Foo_Proxy".
  const bases = new Set<string>();
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const base = name.replace(/_(Implementation|Proxy)$/, "");
    bases.add(base);
  }

  for (const base of Array.from(bases).sort()) {
    const main = readJson(path.join(dir, `${base}.json`));
    const impl = readJson(path.join(dir, `${base}_Implementation.json`));
    const prox = readJson(path.join(dir, `${base}_Proxy.json`));

    // (1) Implementation has transactionHash + address
    if (impl) {
      if (typeof impl.address !== "string") {
        issues.push({
          artifact: `${base}_Implementation.json`,
          severity: "error",
          message: "missing `address` field",
        });
      }
      if (typeof impl.transactionHash !== "string") {
        issues.push({
          artifact: `${base}_Implementation.json`,
          severity: "error",
          message:
            "missing `transactionHash` — will block future upgrades with 'no transaction details found'",
        });
      }
    }

    // (2) main.implementation == impl.address
    if (main && impl && typeof main.implementation === "string") {
      if (!eqAddr(main.implementation, impl.address)) {
        issues.push({
          artifact: `${base}.json`,
          severity: "error",
          message: `\`implementation\` ${main.implementation} != \`${base}_Implementation.json.address\` ${impl.address}`,
        });
      }
    } else if (main && typeof main.implementation === "string" && !impl) {
      issues.push({
        artifact: `${base}.json`,
        severity: "warn",
        message: `\`implementation\` set to ${main.implementation} but no sibling ${base}_Implementation.json`,
      });
    }

    // (3) main.address == proxy.address for proxy deployments
    if (prox && main) {
      if (!eqAddr(main.address, prox.address)) {
        issues.push({
          artifact: `${base}.json`,
          severity: "error",
          message: `\`address\` ${main.address} != \`${base}_Proxy.json.address\` ${prox.address}`,
        });
      }
    }

    // (4) On-chain cross-check
    if (opts.onchain && main && typeof main.address === "string" && typeof main.implementation === "string") {
      try {
        const raw = await ethers.provider.getStorageAt(
          main.address as string,
          EIP1967_IMPL_SLOT
        );
        const onchainImpl = "0x" + raw.slice(-40);
        if (!eqAddr(onchainImpl, main.implementation)) {
          issues.push({
            artifact: `${base}.json`,
            severity: "error",
            message: `on-chain EIP-1967 impl ${onchainImpl} != artifact \`implementation\` ${main.implementation}`,
          });
        }
      } catch (e) {
        issues.push({
          artifact: `${base}.json`,
          severity: "warn",
          message: `could not read on-chain impl slot: ${(e as Error).message}`,
        });
      }
    }
  }

  return issues;
}

async function main() {
  const currentNet = network.name;
  // Auto-enable on-chain cross-check whenever we're pointed at a real
  // network (i.e. anything but hardhat/localhost). This avoids the
  // `npx hardhat run` argv-swallowing pain.
  const onchain = !["hardhat", "localhost"].includes(currentNet);

  const networks = fs.existsSync(DEPLOYMENTS_ROOT)
    ? fs.readdirSync(DEPLOYMENTS_ROOT).filter((d) => {
        const full = path.join(DEPLOYMENTS_ROOT, d);
        return fs.statSync(full).isDirectory();
      })
    : [];

  if (networks.length === 0) {
    console.log("No deployments/<network>/ folders found.");
    return;
  }

  console.log(`Artifact hygiene audit (on-chain check: ${onchain ? "YES" : "no"})`);
  if (onchain) {
    console.log(
      `On-chain reads use hardhat's --network ${currentNet}; only results for\n` +
        `that network below will be cross-checked. Re-run with a different\n` +
        `--network to cross-check another.\n`
    );
  }

  let total = 0;
  for (const net of networks) {
    const doOnchain = onchain && net === currentNet;
    const issues = await auditNetwork(net, { onchain: doOnchain });
    const banner = `=== ${net}${doOnchain ? " (on-chain checked)" : ""} ===`;
    console.log(`\n${banner}`);
    if (issues.length === 0) {
      console.log("  OK — no issues found.");
      continue;
    }
    total += issues.length;
    for (const iss of issues) {
      const tag =
        iss.severity === "error" ? "[ERROR]" : iss.severity === "warn" ? "[warn] " : "[info] ";
      console.log(`  ${tag} ${iss.artifact}: ${iss.message}`);
    }
  }

  console.log(`\nTotal issues: ${total}`);
  if (total > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
