/**
 * Post-upgrade wiring for the tx-based consent registry (create-flow-v2 §12c).
 * Idempotent — safe to re-run; skips writes whose state is already correct.
 *
 *   npx hardhat run scripts/wire-consent.ts --network sepolia
 *
 * Wires:
 *   1. verifier.setConsentRecorder(TransferEOALegacyRouter, true)
 *   2. verifier.setConsentRecorder(TimeLockRouter, true)
 *   3. timeLockRouter.setConsentVerifier(verifier)
 *
 * Pre-requisite: active terms must be published on the verifier
 * (scripts/set-active-terms.ts) or the tx-consent path reverts NoActiveTerms.
 */
import { ethers } from "hardhat";
import * as hre from "hardhat";
import { getContracts } from "./utils";

async function main() {
  const network = hre.network.name;
  const [deployer] = await ethers.getSigners();
  const c = getContracts()[network];

  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", c["EIP712LegacyVerifier"].address);
  const tlRouter = await ethers.getContractAt("TimeLockRouter", c["TimeLockRouter"].address);
  const eoaRouterAddr = c["TransferEOALegacyRouter"].address;

  console.log(`Network: ${network} | Deployer: ${deployer.address}`);
  console.log(`Verifier: ${verifier.address}`);

  const termsHash = await verifier.activeTermsHash();
  if (termsHash === ethers.constants.HashZero) {
    throw new Error("No active terms published — run set-active-terms.ts first (tx-consent would revert).");
  }
  console.log(`Active terms: ${JSON.stringify(await verifier.activeTermsVersion())} (${termsHash})`);

  for (const [label, addr] of [
    ["TransferEOALegacyRouter", eoaRouterAddr],
    ["TimeLockRouter", tlRouter.address],
  ] as const) {
    if (await verifier.consentRecorders(addr)) {
      console.log(`consentRecorders[${label}] already true — skipping`);
    } else {
      const tx = await verifier.setConsentRecorder(addr, true);
      await tx.wait(1);
      console.log(`setConsentRecorder(${label}, true): ${tx.hash}`);
    }
  }

  const currentVerifier = await tlRouter.consentVerifier();
  if (currentVerifier.toLowerCase() === verifier.address.toLowerCase()) {
    console.log("TimeLockRouter.consentVerifier already wired — skipping");
  } else {
    const tx = await tlRouter.setConsentVerifier(verifier.address);
    await tx.wait(1);
    console.log(`setConsentVerifier(${verifier.address}): ${tx.hash}`);
  }

  // Final state echo
  console.log("\nFinal state:");
  console.log("  consentRecorders[EOA router]:", await verifier.consentRecorders(eoaRouterAddr));
  console.log("  consentRecorders[TL router]: ", await verifier.consentRecorders(tlRouter.address));
  console.log("  tlRouter.consentVerifier:    ", await tlRouter.consentVerifier());
  console.log("  eoaRouter.createPaused:      ", await (await ethers.getContractAt("TransferEOALegacyRouter", eoaRouterAddr)).createPaused());
  console.log("  tlRouter.createPaused:       ", await tlRouter.createPaused());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
