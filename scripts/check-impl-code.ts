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
 *
 * Two answers pass. "Byte for byte" is the whole code. "The same code,
 * other metadata" is every byte but the metadata hashes: solc ends each
 * contract's code, and the code of each contract it carries to deploy, with
 * a hash over the source text, so a comment or the line endings of a
 * checkout (CRLF on Windows, LF elsewhere) change that hash and nothing
 * that runs. The source exactly as it was compiled is the one published on
 * Etherscan and Sourcify.
 */
import { artifacts, ethers, network } from "hardhat";
import { getContracts } from "./utils";

/** The end of a contract's code: the CBOR map `{ipfs: <34 bytes>, solc: <3 bytes>}` and its length. */
const METADATA = /a2646970667358221220[0-9a-f]{64}64736f6c6343[0-9a-f]{6}0033/g;
const HASH_OFFSET = 20; // hex characters from the start of the map to the 32-byte hash
const HASH_LENGTH = 64;

/**
 * `code` with its metadata hashes zeroed at the places where `reference`
 * has them, and how many of those hashes are not `reference`'s.
 */
function withoutMetadataHashes(code: string, reference: string): { code: string; differing: number } {
  let out = code;
  let differing = 0;
  METADATA.lastIndex = 0;
  for (let match = METADATA.exec(reference); match; match = METADATA.exec(reference)) {
    const at = match.index + HASH_OFFSET;
    if (out.slice(at, at + HASH_LENGTH) !== reference.slice(at, at + HASH_LENGTH)) differing++;
    out = out.slice(0, at) + "0".repeat(HASH_LENGTH) + out.slice(at + HASH_LENGTH);
  }
  return { code: out, differing };
}

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
    const sameLength = onChain !== "0x" && onChain.length === artifact.deployedBytecode.length;
    const chain = sameLength ? blank(onChain) : onChain;
    const built = blank(artifact.deployedBytecode);
    const exact = sameLength && chain === built;
    const live = withoutMetadataHashes(chain, built);
    const sameCode = sameLength && live.code === withoutMetadataHashes(built, built).code;
    if (!sameCode) failed++;
    const size = `${(onChain.length - 2) / 2} bytes, ${ethers.utils.keccak256(onChain)}`;
    const answer = exact
      ? "the code of this checkout, byte for byte"
      : sameCode
        ? `the same code as this checkout's, other metadata (${live.differing} hash${live.differing === 1 ? "" : "es"} over the source text: a comment or line endings differ from the build that was deployed)`
        : `NOT the artifact's (${(artifact.deployedBytecode.length - 2) / 2} bytes)`;
    console.log(`${sameCode ? "ok  " : "FAIL"} ${name} ${address} on ${network.name}: ${size}, ${answer}`);
  }
  if (failed) throw new Error(`${failed} implementation(s) differ from this checkout.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
