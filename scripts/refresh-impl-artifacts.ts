/**
 * Refresh hardhat-deploy implementation artifacts after a script-based proxy
 * upgrade (upgrade-router-proxy.ts bypasses hardhat-deploy, so the
 * deployments/<net>/<Name>_Implementation.json files go stale — and sync-ui
 * exports ABIs from them).
 *
 * Updates `address` + `abi` (+ bytecode fields) in both the _Implementation
 * artifact and the merged proxy-facade artifact (<Name>.json keeps the proxy
 * address but carries the implementation ABI). Leaves tx metadata alone.
 *
 *   npx hardhat run scripts/refresh-impl-artifacts.ts --network sepolia
 */
import * as fs from "fs";
import * as path from "path";
import * as hre from "hardhat";
import { getContracts } from "./utils";

// deployment name -> { compiled artifact name, sol source path }
const TARGETS: Record<string, string> = {
  TransferEOALegacyRouter: "TransferEOALegacyRouter",
  TimeLockRouter: "TimeLockRouter",
};

async function main() {
  const network = hre.network.name;
  const contracts = getContracts()[network];
  const dir = path.join(__dirname, "..", "deployments", network);

  for (const [deployName, contractName] of Object.entries(TARGETS)) {
    const compiled = await hre.artifacts.readArtifact(contractName);
    const implAddr = contracts[deployName]?.implementation;
    if (!implAddr) throw new Error(`No implementation for ${deployName} in contract-addresses.json`);

    const implPath = path.join(dir, `${deployName}_Implementation.json`);
    const impl = JSON.parse(fs.readFileSync(implPath, "utf8"));
    impl.address = implAddr;
    impl.abi = compiled.abi;
    impl.bytecode = compiled.bytecode;
    impl.deployedBytecode = compiled.deployedBytecode;
    fs.writeFileSync(implPath, JSON.stringify(impl, null, 2) + "\n");
    console.log(`${deployName}_Implementation.json -> address=${implAddr}, abi=${compiled.abi.length} entries`);

    // Merged facade artifact: proxy address + implementation ABI.
    const facadePath = path.join(dir, `${deployName}.json`);
    const facade = JSON.parse(fs.readFileSync(facadePath, "utf8"));
    facade.abi = compiled.abi;
    fs.writeFileSync(facadePath, JSON.stringify(facade, null, 2) + "\n");
    console.log(`${deployName}.json -> abi refreshed (address stays ${facade.address})`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
