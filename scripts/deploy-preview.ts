/**
 * Dry-run preview for `hardhat deploy --network <net>`.
 *
 * For each deployment artifact under deployments/<network>/, compares the
 * stored `bytecode` against the freshly-compiled artifact bytecode (after
 * stripping the Solidity metadata hash, which intentionally drifts on
 * compiler/optimizer/dep changes without affecting semantics). Prints a
 * grouped REUSE / IMPL BUMP / FULL REDEPLOY (DANGER) / NEW summary so we
 * never get surprised mid-deploy by a non-proxy contract being silently
 * redeployed and dependent wiring rotated onto an empty one.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-preview.ts --network mainnet
 *
 * No transactions are sent.
 */
import { ethers, network, artifacts } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface Verdict {
  artifactName: string;
  contractName: string;
  address: string;
  kind: "proxy-impl" | "non-proxy" | "proxy" | "unknown";
  status: "REUSE" | "IMPL_BUMP" | "FULL_REDEPLOY" | "NEW" | "MISSING_SOURCE";
  detail?: string;
}

// Non-proxy contracts that carry chain state — a full redeploy here is
// considered dangerous because dependent wiring may be rotated onto a
// fresh contract with empty state.
const STATEFUL_NON_PROXY = new Set([
  "TokenWhiteList",
  "Payment",
]);

// Strip the Solidity metadata hash (trailing 0xa264… or 0xa265… CBOR blob).
// This is the only thing we expect to drift between equivalent builds.
function stripMetadata(hex: string): string {
  if (!hex || hex === "0x") return hex;
  const h = hex.toLowerCase().startsWith("0x") ? hex.slice(2) : hex;
  // CBOR metadata starts with "a264" (ipfs) or "a165" (bzzr0/1)
  // Length field is the last 4 hex chars (2 bytes big-endian)
  if (h.length < 8) return "0x" + h;
  const lenHex = h.slice(-4);
  const len = parseInt(lenHex, 16);
  const total = (len + 2) * 2; // metadata + 2-byte length field
  if (total >= h.length) return "0x" + h;
  return "0x" + h.slice(0, h.length - total);
}

function classify(artifactName: string): { kind: Verdict["kind"]; contractName: string } {
  if (artifactName.endsWith("_Implementation")) {
    return {
      kind: "proxy-impl",
      contractName: artifactName.replace(/_Implementation$/, ""),
    };
  }
  if (artifactName === "DefaultProxyAdmin") {
    return { kind: "unknown", contractName: artifactName };
  }
  return { kind: "non-proxy", contractName: artifactName };
}

async function main() {
  const net = network.name;
  const deploymentsDir = path.resolve(__dirname, "..", "deployments", net);
  if (!fs.existsSync(deploymentsDir)) {
    throw new Error(`No deployments directory for ${net}`);
  }
  console.log(`\nDeploy preview for network: ${net}`);
  console.log(`(no transactions sent — read-only)\n`);

  const files = fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."));

  const verdicts: Verdict[] = [];
  const proxyHosts: Map<string, string> = new Map(); // contract -> proxy address

  // First pass: collect proxy addresses so we know which top-level
  // artifacts are "proxies" vs "non-proxies"
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    if (name.endsWith("_Implementation")) continue;
    const json = JSON.parse(fs.readFileSync(path.join(deploymentsDir, f), "utf8"));
    // If a sibling *_Implementation.json exists, this is a proxy
    const implSibling = files.includes(`${name}_Implementation.json`);
    if (implSibling) proxyHosts.set(name, json.address);
  }

  for (const f of files) {
    const artifactName = f.replace(/\.json$/, "");
    const json = JSON.parse(fs.readFileSync(path.join(deploymentsDir, f), "utf8"));
    const { kind: rawKind, contractName } = classify(artifactName);

    // For top-level artifacts that have an _Implementation sibling, classify
    // as "proxy" (we don't redeploy the proxy itself, just the impl).
    let kind: Verdict["kind"] = rawKind;
    if (rawKind === "non-proxy" && proxyHosts.has(artifactName)) {
      kind = "proxy";
    }

    if (kind === "proxy" || kind === "unknown") {
      verdicts.push({
        artifactName,
        contractName,
        address: json.address,
        kind,
        status: "REUSE",
        detail: kind === "proxy" ? "proxy bytecode never changes" : undefined,
      });
      continue;
    }

    // Need to compare bytecode: load the freshly-compiled artifact
    let freshBytecode: string;
    try {
      const art = await artifacts.readArtifact(contractName);
      freshBytecode = art.bytecode;
    } catch (e: any) {
      verdicts.push({
        artifactName,
        contractName,
        address: json.address,
        kind,
        status: "MISSING_SOURCE",
        detail: `no source artifact for ${contractName}`,
      });
      continue;
    }

    const stored = stripMetadata(json.bytecode || "");
    const fresh = stripMetadata(freshBytecode || "");

    if (!stored || stored === "0x") {
      verdicts.push({
        artifactName, contractName, address: json.address, kind,
        status: "NEW",
      });
    } else if (stored === fresh) {
      verdicts.push({
        artifactName, contractName, address: json.address, kind,
        status: "REUSE",
      });
    } else {
      const status: Verdict["status"] =
        kind === "proxy-impl" ? "IMPL_BUMP" : "FULL_REDEPLOY";
      verdicts.push({
        artifactName, contractName, address: json.address, kind, status,
      });
    }
  }

  // ── Risk callout ──
  const dangers = verdicts.filter(
    (v) =>
      v.status === "FULL_REDEPLOY" &&
      STATEFUL_NON_PROXY.has(v.contractName)
  );
  if (dangers.length > 0) {
    console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    console.log(`!! DANGER: stateful non-proxy contract(s) will redeploy fresh:`);
    for (const d of dangers) {
      console.log(`!!   ${d.contractName} (currently ${d.address})`);
    }
    console.log(`!! Any dependent wiring that runs deployments.get("X") will`);
    console.log(`!! be rotated onto the new contract. Confirm migration logic`);
    console.log(`!! before running 'hardhat deploy'.`);
    console.log(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
  }

  // ── Grouped summary ──
  const groups: Record<Verdict["status"], Verdict[]> = {
    REUSE: [],
    IMPL_BUMP: [],
    FULL_REDEPLOY: [],
    NEW: [],
    MISSING_SOURCE: [],
  };
  for (const v of verdicts) groups[v.status].push(v);

  const printGroup = (label: string, items: Verdict[]) => {
    if (items.length === 0) return;
    console.log(`${label} (${items.length}):`);
    for (const v of items) {
      const flag = STATEFUL_NON_PROXY.has(v.contractName) ? " [STATEFUL]" : "";
      console.log(`  ${v.artifactName.padEnd(45)} ${v.address}${flag}`);
      if (v.detail) console.log(`    note: ${v.detail}`);
    }
    console.log("");
  };

  printGroup("FULL_REDEPLOY", groups.FULL_REDEPLOY);
  printGroup("IMPL_BUMP", groups.IMPL_BUMP);
  printGroup("NEW", groups.NEW);
  printGroup("MISSING_SOURCE", groups.MISSING_SOURCE);
  printGroup("REUSE", groups.REUSE);

  console.log(`Total artifacts: ${verdicts.length}`);
  console.log(
    `Will change:    ${groups.FULL_REDEPLOY.length + groups.IMPL_BUMP.length + groups.NEW.length}`
  );
  if (dangers.length > 0) {
    process.exitCode = 2;
    console.log(`\n!! Exit code 2 — review dangers above before deploying.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
