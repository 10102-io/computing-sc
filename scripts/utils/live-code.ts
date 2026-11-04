/**
 * On-chain identity helpers shared by refresh-impl-artifacts.ts,
 * train-2026-11.ts and verify-governance.ts. Read-only.
 */
import * as hre from "hardhat";

/**
 * Whether the runtime code at `live` is the compiled `contractName`, with
 * every immutable masked out of the on-chain code through the build-info
 * `immutableReferences` (the compiled artifact has zeros there).
 */
export async function compileAgainstLive(contractName: string, live: string) {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
  const output: any = build?.output.contracts[artifact.sourceName][artifact.contractName];
  const refs: Record<string, { start: number; length: number }[]> = output?.evm.deployedBytecode.immutableReferences ?? {};
  let onChain = (await hre.ethers.provider.getCode(live)).slice(2).toLowerCase();
  const compiled = artifact.deployedBytecode.slice(2).toLowerCase();
  for (const ranges of Object.values(refs)) {
    for (const { start, length } of ranges) {
      onChain = onChain.slice(0, start * 2) + "0".repeat(length * 2) + onChain.slice((start + length) * 2);
    }
  }
  return { matches: onChain.length > 0 && onChain === compiled, storageLayout: output?.storageLayout };
}

/** The storage slot (as a 0x hex quantity) of `label` in `contractName`'s compiled layout. */
export async function storageSlotOf(contractName: string, label: string): Promise<string> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
  const layout: any = build?.output.contracts[artifact.sourceName][artifact.contractName]?.storageLayout;
  const entry = layout?.storage?.find((s: any) => s.label === label);
  if (!entry || entry.offset !== 0) throw new Error(`${contractName}.${label}: no slot in the compiled layout`);
  return hre.ethers.utils.hexValue(Number(entry.slot));
}

/** OpenZeppelin v5 Initializable's namespaced slot (`_initialized` in the low 8 bytes). */
export const INITIALIZABLE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** The EOA router's live initializer counter and code admin (from storage). */
export async function readEoaRouterAdmin(proxy: string): Promise<{ counter: number; codeAdmin: string; implementation: string }> {
  const { ethers } = hre;
  const counter = Number(BigInt("0x" + (await ethers.provider.getStorageAt(proxy, INITIALIZABLE_SLOT)).slice(-16)));
  const slot = await storageSlotOf("TransferEOALegacyRouter", "_codeAdmin");
  const codeAdmin = ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(proxy, slot)).slice(-40));
  const implementation = ethers.utils.getAddress("0x" + (await ethers.provider.getStorageAt(proxy, IMPL_SLOT)).slice(-40));
  return { counter, codeAdmin, implementation };
}
