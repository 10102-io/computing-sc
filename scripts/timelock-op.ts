/**
 * Schedule / inspect / execute / cancel operations on the UpgradeTimelock.
 * This is the runbook tool for every proxy upgrade now that DefaultProxyAdmin
 * is owned by the timelock (see docs/plans/upgrade-timelock.md).
 *
 * Driven by env vars (hardhat run doesn't forward CLI args):
 *
 *   TL_ACTION = schedule | status | execute | cancel        (required)
 *
 *   Proxy-upgrade shorthand (the common case):
 *     TL_PROXY = deployment name (e.g. TransferEOALegacyRouter) or 0x address
 *     TL_IMPL  = new implementation address
 *
 *   Arbitrary call (rare — e.g. updateDelay, ProxyAdmin.transferOwnership):
 *     TL_TARGET = 0x target address
 *     TL_DATA   = 0x calldata
 *
 * Examples (PowerShell):
 *   $env:TL_ACTION="schedule"; $env:TL_PROXY="TransferEOALegacyRouter"; $env:TL_IMPL="0x…"
 *   npx hardhat run scripts/timelock-op.ts --network mainnet
 *   # …wait out the delay, then TL_ACTION="execute" with the same params.
 *
 * The salt is derived deterministically from (target, data), so schedule /
 * status / execute recompute the same operation id from the same inputs.
 */
import { ethers, network, deployments } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

const ZERO32 = "0x" + "00".repeat(32);

async function resolveCall(): Promise<{ target: string; data: string; label: string }> {
  const rawTarget = process.env.TL_TARGET;
  const rawData = process.env.TL_DATA;
  if (rawTarget && rawData) {
    return { target: ethers.utils.getAddress(rawTarget), data: rawData, label: `raw call to ${rawTarget}` };
  }

  const proxyRef = process.env.TL_PROXY;
  const impl = process.env.TL_IMPL;
  if (!proxyRef || !impl) {
    throw new Error("Set either TL_PROXY + TL_IMPL (proxy upgrade) or TL_TARGET + TL_DATA (raw call).");
  }
  const proxyAddr = proxyRef.startsWith("0x")
    ? ethers.utils.getAddress(proxyRef)
    : (await deployments.get(proxyRef)).address;
  const implAddr = ethers.utils.getAddress(impl);

  const implCode = await ethers.provider.getCode(implAddr);
  if (implCode === "0x") throw new Error(`New implementation ${implAddr} has no code on ${network.name}.`);

  const proxyAdminDeployment = await deployments.get("DefaultProxyAdmin");
  const iface = new ethers.utils.Interface(["function upgrade(address proxy, address implementation)"]);
  return {
    target: proxyAdminDeployment.address,
    data: iface.encodeFunctionData("upgrade", [proxyAddr, implAddr]),
    label: `upgrade ${proxyRef} (${proxyAddr}) → ${implAddr}`,
  };
}

async function main() {
  const action = (process.env.TL_ACTION ?? "").toLowerCase();
  if (!["schedule", "status", "execute", "cancel"].includes(action)) {
    throw new Error("Set TL_ACTION to schedule | status | execute | cancel.");
  }

  const [signer] = await ethers.getSigners();
  const timelockAddr = getContracts()[network.name]?.UpgradeTimelock?.address;
  if (!timelockAddr) throw new Error(`No UpgradeTimelock recorded for ${network.name}.`);
  const timelock = await ethers.getContractAt("UpgradeTimelock", timelockAddr, signer as any);

  const { target, data, label } = await resolveCall();
  const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`${target}:${data}`));
  const id: string = await timelock.hashOperation(target, 0, data, ZERO32, salt);

  console.log(`Network:   ${network.name}`);
  console.log(`Timelock:  ${timelockAddr}`);
  console.log(`Operation: ${label}`);
  console.log(`  id:   ${id}`);

  const printStatus = async () => {
    const [pending, ready, done, ts] = await Promise.all([
      timelock.isOperationPending(id),
      timelock.isOperationReady(id),
      timelock.isOperationDone(id),
      timelock.getTimestamp(id),
    ]);
    const eta = ts.gt(1) ? new Date(ts.toNumber() * 1000).toISOString() : "n/a";
    console.log(`  status: pending=${pending} ready=${ready} done=${done} eta=${eta}`);
    return { pending, ready, done };
  };

  if (action === "status") {
    await printStatus();
    return;
  }

  if (action === "schedule") {
    const { pending, done } = await printStatus();
    if (pending || done) throw new Error("Operation already scheduled or executed — nothing to do.");
    const delay = await timelock.getMinDelay();
    const tx = await timelock.schedule(target, 0, data, ZERO32, salt, delay);
    console.log(`  schedule tx: ${tx.hash}`);
    await tx.wait();
    await printStatus();
    console.log(`Scheduled. Execute after the delay with TL_ACTION=execute and the same params.`);
    return;
  }

  if (action === "execute") {
    const { ready } = await printStatus();
    if (!ready) throw new Error("Operation is not ready — check the eta above.");
    const tx = await timelock.execute(target, 0, data, ZERO32, salt);
    console.log(`  execute tx: ${tx.hash}`);
    await tx.wait();
    await printStatus();
    console.log("Executed.");
    return;
  }

  // cancel
  const { pending } = await printStatus();
  if (!pending) throw new Error("Operation is not pending — nothing to cancel.");
  const tx = await timelock.cancel(id);
  console.log(`  cancel tx: ${tx.hash}`);
  await tx.wait();
  console.log("Cancelled.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
