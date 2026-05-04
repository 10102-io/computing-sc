/**
 * Wires an already-deployed TransferEOALegacy implementation into the
 * TransferEOALegacyRouter by calling `setLegacyImplementation(impl)`.
 *
 * Prereqs: caller must be the router's `_codeAdmin`, and the impl must
 * already be deployed. Use `deploy-eoa-clone-impl.ts` for the end-to-end
 * (deploy + wire) flow, and this script only when an impl already exists.
 *
 * Env:
 *   IMPL=0x...  address of the already-deployed TransferEOALegacy impl
 */
import { ethers, deployments, network } from "hardhat";
import { saveContract } from "./utils";

async function main() {
  const implAddr = process.env.IMPL;
  if (!implAddr || !ethers.utils.isAddress(implAddr)) {
    throw new Error("Set IMPL=0x<TransferEOALegacy impl address>");
  }

  const [deployer] = await ethers.getSigners();
  const routerAddr = (await deployments.get("TransferEOALegacyRouter")).address;
  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${await deployer.getAddress()}`);
  console.log(`Router:   ${routerAddr}`);
  console.log(`Impl:     ${implAddr}`);

  const code = await ethers.provider.getCode(implAddr);
  if (code === "0x") throw new Error(`No code at ${implAddr} on ${network.name}`);

  const router = await ethers.getContractAt("TransferEOALegacyRouter", routerAddr, deployer as any);
  const prev: string = await router.legacyImplementation();
  console.log(`Previous legacyImplementation: ${prev}`);

  const tx = await router.setLegacyImplementation(implAddr);
  console.log(`tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed (gas used: ${receipt.gasUsed.toString()})`);

  const post: string = await router.legacyImplementation();
  console.log(`New legacyImplementation: ${post}`);
  if (post.toLowerCase() !== implAddr.toLowerCase()) {
    throw new Error("setLegacyImplementation did not stick.");
  }

  saveContract(network.name, "TransferEOALegacyImpl", implAddr);
  console.log("\nDone. New EOA legacies will deploy as EIP-1167 clones.");
}

main().catch((e) => { console.error(e); process.exit(1); });
