/**
 * Wires the EOA activity auto-renew attestor into the TransferEOALegacyRouter.
 *
 * The attestor is the off-chain worker key allowed to call `recordActivity`
 * (bounded: opt-in legacies only, monotonic nonce, near-deadline window,
 * 365-day budget — see the router natspec / CHANGELOG). address(0) pauses
 * all auto-renewals without touching owner opt-ins.
 *
 * Usage (PowerShell):
 *   $env:ATTESTOR="0x..."; npx hardhat run scripts/set-activity-attestor.ts --network sepolia
 */
import { ethers, network, deployments } from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const attestor = process.env.ATTESTOR;
  if (!attestor || !ethers.utils.isAddress(attestor)) {
    throw new Error("Set ATTESTOR to a valid address (or 0x0000000000000000000000000000000000000000 to pause).");
  }

  const [deployer] = await ethers.getSigners();
  console.log(`Network:  ${network.name} (chainId=${network.config.chainId})`);
  console.log(`Deployer: ${await deployer.getAddress()}`);
  console.log(`Attestor: ${attestor}`);

  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr, deployer as any);

  let current: string;
  try {
    current = await router.activityAttestor();
  } catch {
    throw new Error(
      "Router does not expose `activityAttestor()` — upgrade the proxy to the auto-renew-aware implementation first."
    );
  }
  console.log(`Current attestor: ${current}`);

  const tx = await router.setActivityAttestor(attestor);
  console.log(`setActivityAttestor tx: ${tx.hash}`);
  await tx.wait();

  const wired: string = await router.activityAttestor();
  console.log(`router.activityAttestor(): ${wired}`);
  if (wired.toLowerCase() !== attestor.toLowerCase()) {
    throw new Error("setActivityAttestor did not stick — investigate access control / tx revert");
  }
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
