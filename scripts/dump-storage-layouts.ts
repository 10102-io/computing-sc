/**
 * Dumps the storage layout of every proxy-upgradeable contract to a JSON file,
 * for pre/post solc-bump diffing (docs/plans/solc-upgrade.md "Storage layout
 * verification"). Usage:
 *
 *   npx hardhat run scripts/dump-storage-layouts.ts   # writes storage-layouts.json
 *   OUT=storage-layouts-after.json npx hardhat run scripts/dump-storage-layouts.ts
 *
 * Requires `outputSelection: { "*": { "*": ["storageLayout"] } }` in the
 * solidity compiler settings.
 */
import * as fs from "fs";
import * as path from "path";
import { artifacts } from "hardhat";

const PROXIED_CONTRACTS = [
  "TransferEOALegacyRouter",
  "MultisigLegacyContractRouter",
  "TimeLockRouter",
  // The three timelock vaults are transparent proxies too (round-2026-09.md
  // B1 is their first upgrade); their layouts must be diffed like the router's.
  "TimelockERC20",
  "TimelockERC721",
  "TimelockERC1155",
  "PremiumRegistry",
  "PremiumSetting",
  "LegacyDeployer",
  "VerifierTerm",
  // Clone implementations — not proxies, but their storage must stay aligned
  // with pre-v2 clones for reads through GenericLegacy getters.
  "TransferEOALegacy",
  "MultisigLegacy",
];

async function main() {
  const out: Record<string, unknown> = {};
  for (const name of PROXIED_CONTRACTS) {
    let buildInfo;
    try {
      const artifact = await artifacts.readArtifact(name);
      const fqName = `${artifact.sourceName}:${artifact.contractName}`;
      buildInfo = await artifacts.getBuildInfo(fqName);
      if (!buildInfo) {
        out[name] = "NO BUILD INFO";
        continue;
      }
      const contractOutput = (buildInfo.output.contracts as any)[artifact.sourceName]?.[artifact.contractName];
      const layout = contractOutput?.storageLayout;
      out[name] = layout
        ? // Keep only slot-relevant fields so the diff isn't noisy. Type
          // identifiers embed AST node ids (`t_struct(TimelockInfo)1234_storage`)
          // that change with any edit anywhere in the file, so they are
          // stripped: two dumps differ only when a slot, offset, label or
          // the type's shape differs.
          (layout.storage as any[]).map((s) => ({
            label: s.label,
            slot: s.slot,
            offset: s.offset,
            type: String(s.type).replace(/\)\d+/g, ")").replace(/(\w)\d+_/g, "$1_"),
          }))
        : "NO STORAGE LAYOUT IN OUTPUT";
    } catch (e: any) {
      out[name] = `ERROR: ${e.message}`;
    }
  }
  const outFile = path.join(__dirname, "..", process.env.OUT ?? "storage-layouts.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`wrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
