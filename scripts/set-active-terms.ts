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
 *   # hash the terms text as committed (Markdown from v2026-12 on, a plain
 *   # snapshot of the website's page before):
 *   $env:TERMS_VERSION="v2026-12"; $env:TERMS_FILE="docs/tos/v2026-12.md"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 *   # rehearse first, on a local fork, as the verifier's owner and with no
 *   # key (nothing reaches the network; no --network):
 *   $env:TERMS_FORK="mainnet"; $env:TERMS_VERSION="v2026-12"; $env:TERMS_FILE="docs/tos/v2026-12.md"
 *   npx hardhat run scripts/set-active-terms.ts
 *
 *   # or supply a precomputed hash:
 *   $env:TERMS_VERSION="v2026-07"; $env:TERMS_HASH="0x…32bytes"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 *   # disable versioning (falls back to the legacy message format):
 *   $env:TERMS_CLEAR="true"
 *   npx hardhat run scripts/set-active-terms.ts --network sepolia
 *
 * Requires DEPLOYER_PRIVATE_KEY (verifier owner) in .env, except with
 * TERMS_FORK.
 *
 * Same release: set `TERMS_VERSION` in computing/src/constants/common.ts to
 * the new tag. The in-app checkbox stores the version it accepted, and the
 * routers record that consent against the ACTIVE hash, so a stale constant
 * would record users as accepting terms they were never shown.
 *
 * Order: the app with the new text is live, the website's terms page (which
 * the app's terms links open) shows the new version, then this script. A
 * real run checks both and sends nothing otherwise
 * (`TERMS_SKIP_LIVE_CHECK=1` skips the check).
 */
import * as fs from "fs";
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  // TERMS_FORK = mainnet | sepolia: the same call on a local fork of that
  // network, sent as the verifier's owner (impersonated). No key is used and
  // nothing reaches the network.
  const fork = (process.env.TERMS_FORK ?? "").toLowerCase();
  if (fork) {
    if (hre.network.name !== "hardhat") throw new Error("TERMS_FORK runs on the in-process hardhat network only (no --network).");
    const url = fork === "mainnet" ? process.env.MAINNET_RPC_URL : fork === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
    if (!url) throw new Error("TERMS_FORK is mainnet or sepolia, with its RPC URL in .env.");
    await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
  }
  const network = fork || hre.network.name;

  const verifierAddr = getContracts()[network]?.["EIP712LegacyVerifier"]?.address;
  if (!verifierAddr) throw new Error(`No EIP712LegacyVerifier address for "${network}"`);
  let verifier = await ethers.getContractAt("EIP712LegacyVerifier", verifierAddr);
  const owner: string = await verifier.owner();

  let sender: string;
  if (fork) {
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [owner, "0x8ac7230489e80000"] });
    verifier = verifier.connect((ethers.provider as any).getSigner(owner));
    sender = owner;
  } else {
    const [deployer] = await ethers.getSigners();
    sender = deployer.address;
  }

  console.log(`Network:  ${network}${fork ? " (a local fork: a rehearsal, nothing is sent to the network)" : ""}`);
  console.log(`${fork ? "Sender (the verifier's owner, impersonated)" : "Deployer"}: ${sender}`);
  console.log(`Verifier: ${verifierAddr}`);

  if (owner.toLowerCase() !== sender.toLowerCase()) {
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
      // The published hash is of the LF text (as committed). A Windows checkout
      // with core.autocrlf rewrites it to CRLF, which hashes differently.
      if (text.includes("\r")) {
        throw new Error(`${process.env.TERMS_FILE} has CR characters; hash the LF text as committed`);
      }
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

  // The order of a terms release, as a check: the app already publishes
  // these terms, and the page its terms links open already shows them. A
  // consent recorded before that is recorded against terms the user could
  // not read (on 2026-11-16 the chain moved while the website still showed
  // the previous version). TERMS_SKIP_LIVE_CHECK=1 only for a version that
  // is not meant for users.
  if (!fork && process.env.TERMS_CLEAR !== "true" && process.env.TERMS_SKIP_LIVE_CHECK !== "1") {
    const live = (await (await fetch(`https://app.10102.io/terms/current.json?t=${Date.now()}`)).json()) as { version?: string; hash?: string };
    if (live.version !== version || (live.hash ?? "").toLowerCase() !== hash.toLowerCase()) {
      throw new Error(`app.10102.io publishes ${live.version} ${live.hash}, not ${version} ${hash}. Nothing sent.`);
    }
    const page = (await (await fetch(`https://10102.io/disclosures?t=${Date.now()}`)).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!page.includes(`Terms version: ${version}`)) {
      throw new Error(`10102.io/disclosures does not show "Terms version: ${version}" yet (the website needs a rebuild). Nothing sent.`);
    }
    console.log(`Live check: app.10102.io publishes ${version} with this hash, and 10102.io/disclosures shows ${version}.`);
  }

  const tx = await verifier.setActiveTerms(version, hash);
  console.log(`\nsetActiveTerms tx: ${tx.hash}${fork ? " (on the fork)" : ""}`);
  const receipt = await tx.wait(1);
  console.log(`Gas used: ${receipt.gasUsed.toString()}`);

  // A node behind the receipt's block can still answer the old terms: ask
  // again before calling it confirmed, and fail when it never agrees.
  let gotVersion = "";
  let gotHash = "";
  for (let i = 0; i < 6; i++) {
    gotVersion = await verifier.activeTermsVersion();
    gotHash = await verifier.activeTermsHash();
    if (gotVersion === version && gotHash.toLowerCase() === hash.toLowerCase()) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (gotVersion !== version || gotHash.toLowerCase() !== hash.toLowerCase()) {
    throw new Error(`After the transaction the verifier answers version="${gotVersion}" hash=${gotHash}.`);
  }
  console.log(`Confirmed. activeTermsVersion="${gotVersion}"`);
  console.log(`           activeTermsHash=${gotHash}`);

  // Show what users will now sign, for eyeballing the wallet prompt.
  const ts = Math.floor(Date.now() / 1000);
  console.log(`\nSample message users sign:\n  ${await verifier.generateVersionedMessage(ts)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
