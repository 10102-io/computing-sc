/**
 * Publish (or rotate) the active Terms-of-Service version on the
 * EIP712LegacyVerifier — deferred item `legacy-tos-version`.
 *
 * The verifier binds every new consent signature to {version tag, document
 * hash}. The tag goes inside the human-readable message users sign; the hash
 * (keccak256 of the full ToS document text) stays on-chain linking the tag
 * to the exact terms in force.
 *
 * Usage (PowerShell):
 *   # hash a local snapshot of the ToS document text:
 *   $env:TERMS_VERSION="v2026-07"; $env:TERMS_FILE="docs/tos/v2026-07.txt"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 *   # or supply a precomputed hash:
 *   $env:TERMS_VERSION="v2026-07"; $env:TERMS_HASH="0x…32bytes"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 *   # disable versioning (falls back to the legacy message format):
 *   $env:TERMS_CLEAR="true"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 * Requires DEPLOYER_PRIVATE_KEY (verifier owner) in .env.
 */
import * as fs from "fs";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();

  const verifierAddr = getContracts()[network]?.["EIP712LegacyVerifier"]?.address;
  if (!verifierAddr) throw new Error(`No EIP712LegacyVerifier address for "${network}"`);
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", verifierAddr);

  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Verifier: ${verifierAddr}`);

  const owner = await verifier.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the verifier owner (${owner}).`);
  }

  let version: string;
  let hash: string;

  if (process.env.TERMS_CLEAR === "true") {
    version = "";
    hash = ethers.constants.HashZero;
  } else {
    version = process.env.TERMS_VERSION ?? "";
    if (!version) throw new Error("Set TERMS_VERSION (e.g. v2026-07) or TERMS_CLEAR=true");
    if (process.env.TERMS_HASH) {
      hash = process.env.TERMS_HASH;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("TERMS_HASH must be a 32-byte hex string");
    } else if (process.env.TERMS_FILE) {
      const text = fs.readFileSync(process.env.TERMS_FILE, "utf8");
      hash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(text));
      console.log(`Hashed ${process.env.TERMS_FILE} (${text.length} chars)`);
    } else {
      throw new Error("Set TERMS_HASH or TERMS_FILE");
    }
  }

  const prevVersion = await verifier.activeTermsVersion();
  const prevHash = await verifier.activeTermsHash();
  console.log(`\nCurrent: version="${prevVersion}" hash=${prevHash}`);
  console.log(`New:     version="${version}" hash=${hash}`);

  const tx = await verifier.setActiveTerms(version, hash);
  console.log(`\nsetActiveTerms tx: ${tx.hash}`);
  await tx.wait(1);

  console.log(`Confirmed. activeTermsVersion="${await verifier.activeTermsVersion()}"`);
  console.log(`           activeTermsHash=${await verifier.activeTermsHash()}`);

  // Show what users will now sign, for eyeballing the wallet prompt.
  const ts = Math.floor(Date.now() / 1000);
  console.log(`\nSample message users sign:\n  ${await verifier.generateVersionedMessage(ts)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
