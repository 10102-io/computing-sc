/**
 * Schedule / inspect / execute / cancel operations on the UpgradeTimelock.
 * This is the runbook tool for every proxy upgrade and every role or delay
 * change now that DefaultProxyAdmin is owned by the timelock and the
 * timelock is its own admin (see docs/plans/upgrade-timelock.md and
 * docs/plans/round-2026-09.md).
 *
 * Driven by env vars (hardhat run doesn't forward CLI args):
 *
 *   TL_ACTION = schedule | status | execute | cancel | print      (required)
 *
 *   One operation, proxy-upgrade shorthand (the common case):
 *     TL_PROXY = deployment name (e.g. TransferEOALegacyRouter) or 0x address
 *     TL_IMPL  = new implementation address
 *
 *   One operation, arbitrary call (updateDelay, grantRole, transferOwnership…):
 *     TL_TARGET = 0x target address
 *     TL_DATA   = 0x calldata
 *
 *   Several operations in ONE timelock batch (one id, one window):
 *     TL_BATCH = path to a JSON array of items, each either
 *                { "proxy": "<name|0x>", "impl": "0x…" } or
 *                { "target": "0x…", "data": "0x…", "label": "optional" }
 *
 *   TL_VIA_SAFE = 1 → send schedule/cancel through the governance Safe
 *                (contract-addresses.json governance.safe) with the deployer
 *                as the approving owner. Works only while the Safe has
 *                threshold 1 and the deployer is an owner; otherwise use
 *                TL_ACTION=print and paste into Safe{Wallet}.
 *
 *   print → no transaction. Prints the operation id, salt, delay and eta,
 *           and the exact `schedule`/`scheduleBatch` and `execute`/
 *           `executeBatch` calldata to paste into Safe{Wallet}'s Transaction
 *           Builder (target = the timelock, value 0).
 *
 * Examples (PowerShell):
 *   $env:TL_ACTION="schedule"; $env:TL_PROXY="TransferEOALegacyRouter"; $env:TL_IMPL="0x…"
 *   npx hardhat run scripts/timelock-op.ts --network mainnet
 *   $env:TL_ACTION="print"; $env:TL_BATCH="output/upgrade-batch-sepolia.json"
 *   npx hardhat run scripts/timelock-op.ts --network sepolia
 *
 * The salt is derived deterministically from the (target, data) list, so
 * schedule / status / execute recompute the same operation id from the same
 * inputs. Predecessor is always zero and values are always zero.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers, network, deployments } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";
import { execViaSafe } from "./utils/safe";

dotenv.config();

const ZERO32 = "0x" + "00".repeat(32);

interface Call {
  target: string;
  data: string;
  label: string;
}

async function resolveProxyUpgrade(proxyRef: string, impl: string): Promise<Call> {
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

async function resolveCalls(): Promise<Call[]> {
  const batchPath = process.env.TL_BATCH;
  if (batchPath) {
    const items = JSON.parse(fs.readFileSync(path.resolve(batchPath), "utf-8"));
    if (!Array.isArray(items) || items.length === 0) throw new Error("TL_BATCH must be a non-empty JSON array.");
    const calls: Call[] = [];
    for (const item of items) {
      if (item.proxy && item.impl) calls.push(await resolveProxyUpgrade(item.proxy, item.impl));
      else if (item.target && item.data)
        calls.push({ target: ethers.utils.getAddress(item.target), data: item.data, label: item.label ?? `raw call to ${item.target}` });
      else throw new Error(`Batch item needs {proxy, impl} or {target, data}: ${JSON.stringify(item)}`);
    }
    return calls;
  }

  const rawTarget = process.env.TL_TARGET;
  const rawData = process.env.TL_DATA;
  if (rawTarget && rawData) {
    return [{ target: ethers.utils.getAddress(rawTarget), data: rawData, label: `raw call to ${rawTarget}` }];
  }

  const proxyRef = process.env.TL_PROXY;
  const impl = process.env.TL_IMPL;
  if (!proxyRef || !impl) {
    throw new Error("Set TL_PROXY + TL_IMPL, TL_TARGET + TL_DATA, or TL_BATCH.");
  }
  return [await resolveProxyUpgrade(proxyRef, impl)];
}

async function main() {
  const action = (process.env.TL_ACTION ?? "").toLowerCase();
  if (!["schedule", "status", "execute", "cancel", "print"].includes(action)) {
    throw new Error("Set TL_ACTION to schedule | status | execute | cancel | print.");
  }

  const [signer] = await ethers.getSigners();
  const book = getContracts()[network.name];
  const timelockAddr = book?.UpgradeTimelock?.address;
  if (!timelockAddr) throw new Error(`No UpgradeTimelock recorded for ${network.name}.`);
  const timelock = await ethers.getContractAt("UpgradeTimelock", timelockAddr, signer as any);
  const viaSafe = process.env.TL_VIA_SAFE === "1";
  const safeAddr: string | undefined = (book as any)?.governance?.safe;
  if (viaSafe && !safeAddr) throw new Error(`TL_VIA_SAFE set but no governance.safe recorded for ${network.name}.`);

  const calls = await resolveCalls();
  const isBatch = calls.length > 1;
  const targets = calls.map((c) => c.target);
  const values = calls.map(() => 0);
  const datas = calls.map((c) => c.data);
  const salt = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(calls.map((c) => `${c.target}:${c.data}`).join("|"))
  );
  const id: string = isBatch
    ? await timelock.hashOperationBatch(targets, values, datas, ZERO32, salt)
    : await timelock.hashOperation(targets[0], 0, datas[0], ZERO32, salt);
  const delay: ethers.BigNumber = await timelock.getMinDelay();

  console.log(`Network:   ${network.name}`);
  console.log(`Timelock:  ${timelockAddr}  (minDelay ${delay.toString()} s)`);
  console.log(`Signer:    ${signer.address}${viaSafe ? `  via Safe ${safeAddr}` : ""}`);
  console.log(`Operation: ${isBatch ? `batch of ${calls.length}` : "single"}`);
  calls.forEach((c, i) => console.log(`  [${i}] ${c.label}\n      target ${c.target}\n      data   ${c.data}`));
  console.log(`  salt: ${salt}`);
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

  const scheduleData = isBatch
    ? timelock.interface.encodeFunctionData("scheduleBatch", [targets, values, datas, ZERO32, salt, delay])
    : timelock.interface.encodeFunctionData("schedule", [targets[0], 0, datas[0], ZERO32, salt, delay]);
  const executeData = isBatch
    ? timelock.interface.encodeFunctionData("executeBatch", [targets, values, datas, ZERO32, salt])
    : timelock.interface.encodeFunctionData("execute", [targets[0], 0, datas[0], ZERO32, salt]);
  const cancelData = timelock.interface.encodeFunctionData("cancel", [id]);

  if (action === "print") {
    await printStatus();
    const eta = new Date((Math.floor(Date.now() / 1000) + delay.toNumber()) * 1000).toISOString();
    console.log(`\nIf scheduled now, executable from ~${eta}`);
    console.log(`\nSafe Transaction Builder, contract ${timelockAddr}, value 0:`);
    console.log(`  schedule${isBatch ? "Batch" : ""} calldata:\n  ${scheduleData}`);
    console.log(`  execute${isBatch ? "Batch" : ""} calldata (anyone, after the eta):\n  ${executeData}`);
    console.log(`  cancel calldata (a CANCELLER, e.g. the guardian, before the eta):\n  ${cancelData}`);
    return;
  }

  if (action === "status") {
    await printStatus();
    return;
  }

  const send = async (data: string, what: string) => {
    const tx = viaSafe
      ? await execViaSafe(signer as any, safeAddr!, timelockAddr, data)
      : await signer.sendTransaction({ to: timelockAddr, data });
    console.log(`  ${what} tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`${what} transaction reverted`);
  };

  if (action === "schedule") {
    const { pending, done } = await printStatus();
    if (pending || done) throw new Error("Operation already scheduled or executed — nothing to do.");
    await send(scheduleData, "schedule");
    await printStatus();
    console.log(`Scheduled. Execute after the delay with TL_ACTION=execute and the same params.`);
    return;
  }

  if (action === "execute") {
    const { ready } = await printStatus();
    if (!ready) throw new Error("Operation is not ready — check the eta above.");
    // Execution is permissionless; never routed through the Safe.
    const tx = await signer.sendTransaction({ to: timelockAddr, data: executeData });
    console.log(`  execute tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error("execute transaction reverted");
    await printStatus();
    console.log("Executed.");
    return;
  }

  // cancel
  const { pending } = await printStatus();
  if (!pending) throw new Error("Operation is not pending — nothing to cancel.");
  await send(cancelData, "cancel");
  console.log("Cancelled.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
