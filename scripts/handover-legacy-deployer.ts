/**
 * Moves the ownership of `LegacyDeployer` from the maintainer key to the
 * `UpgradeTimelock`. The owner's one power is `setParams`: it names the three
 * routers that may deploy a legacy (and, for a Safe legacy, its guard) at the
 * address a router announced to a user. That is a rotation lever like the
 * EOA router's, so it waits behind the same delay as an upgrade. Idempotent:
 * a second run finds the timelock as owner and sends nothing.
 *
 *   # rehearse first, on a local fork, as the current owner and with no key
 *   $env:HANDOVER_FORK="mainnet"; npx hardhat run scripts/handover-legacy-deployer.ts
 *
 *   npx hardhat run scripts/handover-legacy-deployer.ts --network sepolia
 *   npx hardhat run scripts/handover-legacy-deployer.ts --network mainnet
 *
 * Afterwards `setParams` is a timelock operation:
 *   TL_TARGET = the LegacyDeployer proxy, TL_DATA = setParams(...) calldata
 *   (scripts/timelock-op.ts). The rehearsal proves the timelock can send it.
 */
import hre, { ethers } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";
import { revertedWith } from "../test/utils/revert";

dotenv.config();

const ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
  "function multisigLegacyRouter() view returns (address)",
  "function transferLegacyRouter() view returns (address)",
  "function transferEOALegacyRouter() view returns (address)",
  "function setParams(address _multisigLegacyRouter, address _transferLegacyRouter, address _transferEOALegacyRouter)",
];
const same = (a?: string, b?: string) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

async function main() {
  const fork = (process.env.HANDOVER_FORK ?? "").toLowerCase();
  if (fork) {
    if (hre.network.name !== "hardhat") throw new Error("HANDOVER_FORK runs on the in-process hardhat network only (no --network).");
    const url = fork === "mainnet" ? process.env.MAINNET_RPC_URL : fork === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
    if (!url) throw new Error("HANDOVER_FORK is mainnet or sepolia, with its RPC URL in .env.");
    await hre.network.provider.request({ method: "hardhat_reset", params: [{ forking: { jsonRpcUrl: url } }] });
  }
  const network = fork || hre.network.name;
  const book = getContracts()[network] as any;
  const deployerAddr: string | undefined = book?.LegacyDeployer?.address;
  const timelock: string | undefined = book?.UpgradeTimelock?.address;
  const safeRouter: string | undefined = book?.MultisigLegacyRouter?.address;
  const eoaRouter: string | undefined = book?.TransferEOALegacyRouter?.address;
  if (!deployerAddr || !timelock || !safeRouter || !eoaRouter) throw new Error(`LegacyDeployer, UpgradeTimelock or a router is not recorded for ${network}.`);
  if ((await ethers.provider.getCode(timelock)) === "0x") throw new Error(`UpgradeTimelock ${timelock} has no code on ${network}.`);

  const read = new ethers.Contract(deployerAddr, ABI, ethers.provider);
  const wiring = async () => Promise.all([read.multisigLegacyRouter(), read.transferLegacyRouter(), read.transferEOALegacyRouter()]) as Promise<[string, string, string]>;
  const before = await wiring();
  const owner: string = await read.owner();
  console.log(`Network ${network}${fork ? " (a local fork: a rehearsal, nothing is sent to the network)" : ""}`);
  console.log(`LegacyDeployer ${deployerAddr}, owner ${owner}`);
  console.log(`UpgradeTimelock ${timelock}`);
  // The hand-over must not freeze a wrong wiring behind the delay.
  if (!same(before[0], safeRouter) || !same(before[2], eoaRouter)) {
    throw new Error(`The deployer serves ${before[0]} and ${before[2]}, not the recorded routers ${safeRouter} and ${eoaRouter}: nothing sent.`);
  }
  console.log(`  ok   it serves the recorded Safe router and EOA router (the sunset router: ${before[1]})`);

  if (same(owner, timelock)) {
    console.log("  ok   the timelock is the owner already: nothing to send");
    if (!fork) return;
  }

  let sender: any;
  if (fork) {
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [owner] });
    await hre.network.provider.request({ method: "hardhat_setBalance", params: [owner, "0x8AC7230489E80000"] });
    sender = await ethers.getSigner(owner);
  } else {
    [sender] = await ethers.getSigners();
    if (!same(sender.address, owner)) throw new Error(`The key in .env is ${sender.address}; the owner is ${owner}: nothing sent.`);
  }

  if (!same(owner, timelock)) {
    const tx = await read.connect(sender).transferOwnership(timelock);
    console.log(`  transferOwnership to the timelock: ${tx.hash}${fork ? " (on the fork)" : ""}`);
    const receipt = await tx.wait(fork ? 1 : 2);
    console.log(`  mined in block ${receipt.blockNumber}, ${receipt.gasUsed.toString()} gas`);
  }

  const after = await wiring();
  const newOwner: string = await read.owner();
  if (!same(newOwner, timelock)) throw new Error(`The owner is ${newOwner}, not the timelock.`);
  if (after.join() !== before.join()) throw new Error("The wiring changed.");
  console.log("  ok   the owner is the timelock, the wiring is as before");

  if (!fork) return;

  // On the fork only: what the hand-over means afterwards.
  let refusal: unknown;
  try {
    await (await read.connect(sender).setParams(before[0], before[1], before[2])).wait();
  } catch (err) {
    refusal = err;
  }
  if (!refusal || !revertedWith(refusal, "OwnableUnauthorizedAccount(address)")) {
    throw new Error(`The former owner was not refused as an account that is not the owner: ${refusal ? (refusal as any).message : "the call went through"}`);
  }
  console.log("  ok   the former owner can no longer name the routers (OwnableUnauthorizedAccount)");

  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [timelock] });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [timelock, "0x8AC7230489E80000"] });
  const asTimelock = await ethers.getSigner(timelock);
  await (await read.connect(asTimelock).setParams(before[0], before[1], before[2])).wait();
  if ((await wiring()).join() !== before.join()) throw new Error("setParams as the timelock changed the wiring.");
  console.log("  ok   the timelock can: setParams with the same three routers went through");
  console.log("\nREHEARSAL PASSED: nothing was sent to a real network.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
