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
 *   3. rewrite the _Implementation artifact (address, abi, bytecode, storage
 *      layout) and the merged facade artifact (implementation address + abi;
 *      proxy address untouched).
 *
 * The compiled ABI, bytecode and storage layout are written only when the
 * compiled runtime code equals the live code (immutables masked). Implementations built by an
 * older compiler (solc 0.8.20 before the 2026-07 bump) do not match: then the
 * addresses are corrected, the facade takes the ABI of an _Implementation
 * artifact that already records the live address, and anything else is left
 * as recorded with a warning to check by hand.
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

async function compileAgainstLive(contractName: string, live: string) {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
  const output: any = build?.output.contracts[artifact.sourceName][artifact.contractName];
  const refs: Record<string, { start: number; length: number }[]> = output?.evm.deployedBytecode.immutableReferences ?? {};
  let onChain = (await ethers.provider.getCode(live)).slice(2).toLowerCase();
  const compiled = artifact.deployedBytecode.slice(2).toLowerCase();
  for (const ranges of Object.values(refs)) {
    for (const { start, length } of ranges) {
      onChain = onChain.slice(0, start * 2) + "0".repeat(length * 2) + onChain.slice((start + length) * 2);
    }
  }
  return { matches: onChain === compiled, storageLayout: output?.storageLayout };
}

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
    const { matches, storageLayout } = await compileAgainstLive(contractName, live);
    const implPath = path.join(dir, `${deployName}_Implementation.json`);
    let abi: unknown[] | undefined = matches ? compiled.abi : undefined;
    if (fs.existsSync(implPath)) {
      const impl = JSON.parse(fs.readFileSync(implPath, "utf8"));
      if (matches) {
        impl.abi = compiled.abi;
        impl.bytecode = compiled.bytecode;
        impl.deployedBytecode = compiled.deployedBytecode;
        if (storageLayout) impl.storageLayout = storageLayout;
        console.log(`  ${deployName}_Implementation.json -> ${live}, ${compiled.abi.length} ABI entries`);
      } else if ((impl.address ?? "").toLowerCase() === live.toLowerCase()) {
        abi = impl.abi;
        console.log(`  ${deployName}_Implementation.json: compiled code differs from the live code; recorded artifact kept`);
      } else {
        console.log(`  WARNING ${deployName}_Implementation.json: compiled code differs from the live code; address set to ${live}, ABI and bytecode NOT confirmed, check by hand`);
      }
      impl.address = live;
      fs.writeFileSync(implPath, JSON.stringify(impl, null, 2) + "\n");
    } else {
      console.log(`  ${deployName}_Implementation.json missing, skipped`);
    }

    const facadePath = path.join(dir, `${deployName}.json`);
    if (fs.existsSync(facadePath)) {
      const facade = JSON.parse(fs.readFileSync(facadePath, "utf8"));
      if (abi) facade.abi = abi;
      if (facade.implementation) facade.implementation = live;
      fs.writeFileSync(facadePath, JSON.stringify(facade, null, 2) + "\n");
      console.log(`  ${deployName}.json -> ${abi ? "abi refreshed" : "implementation address only"} (proxy ${facade.address})`);
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
