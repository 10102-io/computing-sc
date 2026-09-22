/**
 * Reconcile artifacts after a timelocked proxy upgrade has EXECUTED.
 *
 * Timelock upgrades bypass hardhat-deploy, so deployments/<net>/<Name>.json
 * and <Name>_Implementation.json go stale, and sync-ui exports ABIs from
 * them. For every deployment named in IMPLS (default: all known proxies):
 *
 *   1. read the live implementation through the EIP-1967 slot of the proxy,
 *   2. if contract-addresses.json has `pendingImplementation` equal to it,
 *      promote it to `implementation` and drop the pending field; if it has
 *      a different `implementation`, update it and say so,
 *   3. rewrite the _Implementation artifact (address, abi, bytecode) and the
 *      merged facade artifact (implementation address + abi; proxy address
 *      untouched).
 *
 *   $env:IMPLS="TimeLockRouter,TimelockERC20,TimelockERC721,TimelockERC1155"
 *   npx hardhat run scripts/refresh-impl-artifacts.ts --network sepolia
 */
import * as fs from "fs";
import * as path from "path";
import * as hre from "hardhat";
import { ethers } from "hardhat";
import { getContracts } from "./utils";

// deployment name -> compiled artifact name
const KNOWN: Record<string, string> = {
  TransferEOALegacyRouter: "TransferEOALegacyRouter",
  MultisigLegacyRouter: "MultisigLegacyRouter",
  TimeLockRouter: "TimeLockRouter",
  TimelockERC20: "TimelockERC20",
  TimelockERC721: "TimelockERC721",
  TimelockERC1155: "TimelockERC1155",
  EIP712LegacyVerifier: "EIP712LegacyVerifier",
  PremiumRegistry: "PremiumRegistry",
  PremiumSetting: "PremiumSetting",
};
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const network = hre.network.name;
  const book = getContracts();
  const contracts = book[network];
  if (!contracts) throw new Error(`No addresses for ${network}`);
  const dir = path.join(__dirname, "..", "deployments", network);
  const names = (process.env.IMPLS ?? Object.keys(KNOWN).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let bookChanged = false;
  for (const deployName of names) {
    const contractName = KNOWN[deployName];
    if (!contractName) throw new Error(`${deployName} is not a known proxy deployment`);
    const entry = contracts[deployName] as any;
    if (!entry?.address) {
      console.log(`${deployName}: not deployed on ${network}, skipped`);
      continue;
    }

    const raw = await ethers.provider.getStorageAt(entry.address, IMPL_SLOT);
    const live = ethers.utils.getAddress("0x" + raw.slice(-40));
    if (entry.pendingImplementation && entry.pendingImplementation.toLowerCase() === live.toLowerCase()) {
      entry.implementation = live;
      delete entry.pendingImplementation;
      bookChanged = true;
      console.log(`${deployName}: pending implementation is live, promoted -> ${live}`);
    } else if (entry.pendingImplementation) {
      console.log(`${deployName}: pending ${entry.pendingImplementation} is NOT live yet (live ${live}); artifacts left alone`);
      continue;
    } else if ((entry.implementation ?? "").toLowerCase() !== live.toLowerCase()) {
      console.log(`${deployName}: recorded ${entry.implementation ?? "none"} but live is ${live}; recording live`);
      entry.implementation = live;
      bookChanged = true;
    }

    const compiled = await hre.artifacts.readArtifact(contractName);
    const implPath = path.join(dir, `${deployName}_Implementation.json`);
    if (fs.existsSync(implPath)) {
      const impl = JSON.parse(fs.readFileSync(implPath, "utf8"));
      impl.address = live;
      impl.abi = compiled.abi;
      impl.bytecode = compiled.bytecode;
      impl.deployedBytecode = compiled.deployedBytecode;
      fs.writeFileSync(implPath, JSON.stringify(impl, null, 2) + "\n");
      console.log(`  ${deployName}_Implementation.json -> ${live}, ${compiled.abi.length} ABI entries`);
    } else {
      console.log(`  ${deployName}_Implementation.json missing, skipped`);
    }

    const facadePath = path.join(dir, `${deployName}.json`);
    if (fs.existsSync(facadePath)) {
      const facade = JSON.parse(fs.readFileSync(facadePath, "utf8"));
      facade.abi = compiled.abi;
      if (facade.implementation) facade.implementation = live;
      fs.writeFileSync(facadePath, JSON.stringify(facade, null, 2) + "\n");
      console.log(`  ${deployName}.json -> abi refreshed (proxy ${facade.address})`);
    }
  }

  if (bookChanged) {
    fs.writeFileSync(path.join(__dirname, "..", "contract-addresses.json"), JSON.stringify(book, null, 2) + "\n");
    console.log("contract-addresses.json updated.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
