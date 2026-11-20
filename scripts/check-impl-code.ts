/**
 * Is the code at an implementation address the code this checkout compiles?
 * Read-only, no key. For each `Name@0xaddress` in IMPL_CHECK the runtime
 * code on the network is compared with the artifact's, byte for byte, with
 * the immutables' places set aside (they hold values, not code).
 *
 *   $env:IMPL_CHECK='LegacyDeployer@0x…,MultisigLegacyRouter@0x…'
 *   npx hardhat run scripts/check-impl-code.ts --network sepolia
 *
 * Without IMPL_CHECK it reads every `pendingImplementation` recorded for
 * the network in contract-addresses.json.
 */
import { artifacts, ethers, network } from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const net = getContracts()[network.name] ?? {};
  const pairs = (process.env.IMPL_CHECK ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("@") as [string, string]);
  if (pairs.length === 0) {
    for (const [name, entry] of Object.entries(net)) {
      const pending = (entry as any)?.pendingImplementation;
      if (pending) pairs.push([name, pending]);
    }
  }
  if (pairs.length === 0) throw new Error("Nothing to check: set IMPL_CHECK or record a pendingImplementation.");

  let failed = 0;
  for (const [name, address] of pairs) {
    const artifact = await artifacts.readArtifact(name);
    const info = await artifacts.getBuildInfo(`${artifact.sourceName}:${name}`);
    const refs = info?.output.contracts[artifact.sourceName][name].evm.deployedBytecode.immutableReferences ?? {};
    const blank = (hex: string) => {
      const bytes = ethers.utils.arrayify(hex);
      for (const places of Object.values(refs) as Array<Array<{ start: number; length: number }>>) {
        for (const { start, length } of places) bytes.fill(0, start, start + length);
      }
      return ethers.utils.hexlify(bytes);
    };
    const onChain = await ethers.provider.getCode(address);
    const same = onChain !== "0x" && onChain.length === artifact.deployedBytecode.length && blank(onChain) === blank(artifact.deployedBytecode);
    if (!same) failed++;
    console.log(
      `${same ? "ok  " : "FAIL"} ${name} ${address} on ${network.name}: ${(onChain.length - 2) / 2} bytes, ${ethers.utils.keccak256(onChain)}${
        same ? ", the code of this checkout" : `, NOT the artifact's (${(artifact.deployedBytecode.length - 2) / 2} bytes)`
      }`,
    );
  }
  if (failed) throw new Error(`${failed} implementation(s) differ from this checkout.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
