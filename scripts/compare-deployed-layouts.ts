/**
 * Compares the storage layout of the current source (a dump written by
 * scripts/dump-storage-layouts.ts) with the `storageLayout` hardhat-deploy
 * recorded for each live implementation in deployments/<network>/. Every
 * deployed variable must keep its label, slot and offset (append-only).
 *
 *   $env:OUT="output/storage-layouts-after.json"; npx hardhat run scripts/dump-storage-layouts.ts
 *   $env:LAYOUTS="output/storage-layouts-after.json"; npx hardhat run scripts/compare-deployed-layouts.ts --network mainnet
 *
 * Read-only. Note: a deployment artifact is only as current as the last
 * refresh-impl-artifacts.ts run; the script prints the artifact's address so
 * a stale one shows.
 */
import * as fs from "fs";
import * as path from "path";
import { network } from "hardhat";

const PROXIES = ["TransferEOALegacyRouter", "TimeLockRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"];

async function main() {
  const layoutsPath = path.resolve(process.env.LAYOUTS ?? "storage-layouts.json");
  const current = JSON.parse(fs.readFileSync(layoutsPath, "utf-8"));
  const net = network.name === "hardhat" ? "mainnet" : network.name;
  let failures = 0;
  for (const name of PROXIES) {
    const file = path.join(__dirname, "..", "deployments", net, `${name}_Implementation.json`);
    if (!fs.existsSync(file)) {
      console.log(`${name}: no deployment artifact on ${net}`);
      continue;
    }
    const artifact = JSON.parse(fs.readFileSync(file, "utf-8"));
    const deployed: any[] = artifact.storageLayout?.storage ?? [];
    const now: any[] = current[name];
    // A contract-typed slot and an address slot are the same 20-byte value.
    const type = (t: string) => String(t).replace(/\)\d+/g, ")").replace(/(\w)\d+_/g, "$1_").replace(/^t_contract\([^)]*\)$/, "t_address");
    const same = (e: any, n: any) => n && n.slot === e.slot && n.offset === e.offset && type(n.type) === type(e.type);
    const broken = deployed.filter((e, i) => !same(e, now[i]));
    const renamed = deployed.filter((e, i) => same(e, now[i]) && now[i].label !== e.label).map((e) => `${e.label}`);
    if (broken.length) failures++;
    console.log(
      `${name.padEnd(24)} artifact ${artifact.address}  deployed ${deployed.length} vars, source ${now.length}: ` +
        (broken.length ? `CHANGED at ${broken[0].label} slot ${broken[0].slot}` : "append-only") +
        (renamed.length ? ` (label-only renames, same slot and type: ${renamed.join(", ")})` : "")
    );
  }
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
