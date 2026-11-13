/**
 * Rehearses a SCHEDULED UpgradeTimelock operation against the live state of
 * a network, on a local fork: nothing is sent to a real network and no key
 * is needed.
 *
 * It answers, before the real execution: is the operation that the batch
 * file describes the one that is pending on chain; does it stay locked until
 * its eta; does it execute from an address that holds no role; how much gas
 * does that take; and what does it change. Every zero-argument getter of the
 * contracts it touches and the EIP-1967 implementation of every recorded
 * proxy are read before and after, and each difference is printed, so a
 * change nobody meant shows up here and not on the network.
 *
 * Env (hardhat run forwards no CLI args):
 *   REHEARSE_NETWORK = mainnet | sepolia          (default mainnet)
 *   TL_BATCH / TL_TARGET + TL_DATA / TL_PROXY + TL_IMPL, TL_SALT_TAG
 *                      exactly as for timelock-op.ts (same salt, same id)
 *   REHEARSE_WATCH   = comma list of `ArtifactName@0xaddress` to diff as
 *                      well (the timelock, the proxy admin and every batch
 *                      target that is a recorded contract are always read)
 *   REHEARSE_SMOKE   = b → after the execution, run the wave B smoke
 *                      (scripts/smoke-train-2026-11-b.ts) on the fork. Once
 *                      the operation has executed on the network, the same
 *                      command runs the smoke alone, on a fork of the
 *                      network as it is then
 *   REHEARSE_AS      = address the smoke runs as (impersonated on the fork;
 *                      the maintainer EOA, for its roles)
 *
 * PowerShell:
 *   $env:TL_BATCH='docs\plans\batches\train-2026-11-wave-b-mainnet.json'
 *   npx hardhat run scripts/rehearse-timelock-op.ts
 *
 * The fork is taken at the latest block through MAINNET_RPC_URL or
 * SEPOLIA_RPC_URL. A provider without archive state serves it for about
 * half an hour, which is far longer than a run.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers, network, artifacts } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

const ZERO32 = "0x" + "00".repeat(32);
/** EIP-1967: keccak256 of the name, minus one. */
const slotOf = (name: string) => ethers.utils.hexZeroPad(ethers.BigNumber.from(ethers.utils.id(name)).sub(1).toHexString(), 32);
const IMPL_SLOT = slotOf("eip1967.proxy.implementation");
const ADMIN_SLOT = slotOf("eip1967.proxy.admin");
/** Holds no role anywhere: the execution must work for anyone. */
const ANYONE = "0x00000000000000000000000000000000000A11CE";

interface Call {
  target: string;
  data: string;
  label: string;
}

// ethers v5 at runtime; the installed typings describe v6 (as in the other scripts).
const provider = ethers.provider as any;
const rpc = (method: string, params: unknown[] = []) => network.provider.request({ method, params });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function deploymentAddress(net: string, name: string): string {
  const file = path.join(__dirname, "..", "deployments", net, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment ${name} recorded for ${net}.`);
  return ethers.utils.getAddress(JSON.parse(fs.readFileSync(file, "utf-8")).address);
}

/** The same resolution as timelock-op.ts, read from the forked network's records. */
async function resolveCalls(net: string): Promise<Call[]> {
  const upgrade = async (proxyRef: string, impl: string): Promise<Call> => {
    const proxy = proxyRef.startsWith("0x") ? ethers.utils.getAddress(proxyRef) : deploymentAddress(net, proxyRef);
    const implAddr = ethers.utils.getAddress(impl);
    if ((await provider.getCode(implAddr)) === "0x") throw new Error(`New implementation ${implAddr} has no code on ${net}.`);
    const iface = new ethers.utils.Interface(["function upgrade(address proxy, address implementation)"]);
    return {
      target: deploymentAddress(net, "DefaultProxyAdmin"),
      data: iface.encodeFunctionData("upgrade", [proxy, implAddr]),
      label: `upgrade ${proxyRef} (${proxy}) → ${implAddr}`,
    };
  };
  const batchPath = process.env.TL_BATCH;
  if (batchPath) {
    const items = JSON.parse(fs.readFileSync(path.resolve(batchPath), "utf-8"));
    if (!Array.isArray(items) || items.length === 0) throw new Error("TL_BATCH must be a non-empty JSON array.");
    const calls: Call[] = [];
    for (const item of items) {
      if (item.proxy && item.impl) calls.push(await upgrade(item.proxy, item.impl));
      else if (item.target && item.data)
        calls.push({ target: ethers.utils.getAddress(item.target), data: item.data, label: item.label ?? `raw call to ${item.target}` });
      else throw new Error(`Batch item needs {proxy, impl} or {target, data}: ${JSON.stringify(item)}`);
    }
    return calls;
  }
  if (process.env.TL_TARGET && process.env.TL_DATA) {
    return [{ target: ethers.utils.getAddress(process.env.TL_TARGET), data: process.env.TL_DATA, label: `raw call to ${process.env.TL_TARGET}` }];
  }
  if (process.env.TL_PROXY && process.env.TL_IMPL) return [await upgrade(process.env.TL_PROXY, process.env.TL_IMPL)];
  throw new Error("Set TL_BATCH, TL_TARGET + TL_DATA, or TL_PROXY + TL_IMPL.");
}

type Snapshot = Record<string, string>;

/** Every zero-argument view of each watched contract, plus the implementation and admin slot of every recorded proxy. */
async function snapshot(watch: { name: string; artifact: string; address: string }[], proxies: Record<string, string>): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const w of watch) {
    const abi = (await artifacts.readArtifact(w.artifact)).abi;
    const c = new ethers.Contract(w.address, abi, provider);
    const getters = abi.filter(
      (f: any) => f.type === "function" && f.inputs.length === 0 && (f.stateMutability === "view" || f.stateMutability === "pure")
    );
    await Promise.all(
      getters.map(async (f: any) => {
        try {
          out[`${w.name}.${f.name}()`] = String(await c[f.name]());
        } catch {
          out[`${w.name}.${f.name}()`] = "(reverts)";
        }
      })
    );
  }
  await Promise.all(
    Object.entries(proxies).map(async ([name, address]) => {
      const [impl, admin] = await Promise.all([
        provider.getStorageAt(address, IMPL_SLOT),
        provider.getStorageAt(address, ADMIN_SLOT),
      ]);
      if (impl !== ZERO32) out[`${name} implementation`] = ethers.utils.getAddress("0x" + impl.slice(26));
      if (admin !== ZERO32) out[`${name} proxy admin`] = ethers.utils.getAddress("0x" + admin.slice(26));
    })
  );
  return out;
}

async function main() {
  if (network.name !== "hardhat") throw new Error("A rehearsal runs on the in-process hardhat network only (no --network).");
  const net = (process.env.REHEARSE_NETWORK ?? "mainnet").toLowerCase();
  const url = net === "mainnet" ? process.env.MAINNET_RPC_URL : net === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
  if (!url) throw new Error(`Set ${net === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"} in .env (REHEARSE_NETWORK is mainnet or sepolia).`);
  const book: any = (getContracts() as any)[net];
  const timelockAddr: string | undefined = book?.UpgradeTimelock?.address;
  if (!timelockAddr) throw new Error(`No UpgradeTimelock recorded for ${net}.`);

  await rpc("hardhat_reset", [{ forking: { jsonRpcUrl: url } }]);
  const forkBlock = await provider.getBlock("latest");
  console.log(`Fork of ${net} at block ${forkBlock.number} (${new Date(forkBlock.timestamp * 1000).toISOString()}). Nothing here reaches ${net}.`);
  // Reads at the fork block itself see the forked network's chain id, reads
  // after the first local block see hardhat's. One empty block first, so the
  // values before and after are read under the same rules and a chain id
  // inside an EIP-712 domain does not show up as a change.
  await rpc("evm_mine");

  const timelock = new ethers.Contract(timelockAddr, (await artifacts.readArtifact("UpgradeTimelock")).abi, provider);
  const calls = await resolveCalls(net);
  const isBatch = calls.length > 1;
  const targets = calls.map((c) => c.target);
  const values = calls.map(() => 0);
  const datas = calls.map((c) => c.data);
  const saltTag = process.env.TL_SALT_TAG ? `#${process.env.TL_SALT_TAG}` : "";
  const salt = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(calls.map((c) => `${c.target}:${c.data}`).join("|") + saltTag));
  const id: string = isBatch
    ? await timelock.hashOperationBatch(targets, values, datas, ZERO32, salt)
    : await timelock.hashOperation(targets[0], 0, datas[0], ZERO32, salt);
  console.log(`Operation: ${isBatch ? `batch of ${calls.length}` : "single"}, id ${id}`);
  calls.forEach((c, i) => console.log(`  [${i}] ${c.label}`));

  const checks: { what: string; ok: boolean; detail: string }[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    checks.push({ what, ok, detail });
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  };

  // The train's smoke on the fork (REHEARSE_SMOKE=b): after the rehearsed execution or, once the
  // operation has really executed, on a fork of the network as it then is.
  const wantsSmoke = (process.env.REHEARSE_SMOKE ?? "").toLowerCase() === "b";
  const smokeB = async (what: string) => {
    const as = process.env.REHEARSE_AS;
    if (!as) throw new Error("REHEARSE_SMOKE needs REHEARSE_AS (the address the smoke runs as).");
    const who = ethers.utils.getAddress(as);
    console.log(`\nWave B smoke on the fork, as ${who}:`);
    await rpc("hardhat_impersonateAccount", [who]);
    await rpc("hardhat_setBalance", [who, "0x8ac7230489e80000"]); // 10 ETH, on the fork only
    process.env.SMOKE_LIBRARY = "1";
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runSmokeB } = require("./smoke-train-2026-11-b");
    const train = book.train202611 ?? {};
    const pick = (what: string, ...vals: Array<string | undefined>) => {
      const v = vals.find(Boolean);
      if (!v) throw new Error(`missing address: ${what}`);
      return ethers.utils.getAddress(v);
    };
    const base = (await provider.getBlock("latest")).baseFeePerGas ?? ethers.BigNumber.from(0);
    const gasPrice = base.mul(2).add(1);
    const ok: boolean = await runSmokeB({
      deployer: provider.getSigner(who),
      addresses: {
        router: pick("TransferEOALegacyRouter", book.TransferEOALegacyRouter?.address),
        v3: pick("TransferEOALegacyV3Impl", train.TransferEOALegacyV3Impl, book.TransferEOALegacyImpl?.address),
        nftList: pick("NftCollectionWhiteList", train.NftCollectionWhiteList, book.NftCollectionWhiteList?.address),
        vault2: pick("LegacyPullVault (v2)", train.LegacyPullVaultV2, book.LegacyPullVault?.address),
        premiumRegistry: pick("PremiumRegistry", book.PremiumRegistry?.address),
        verifier: pick("EIP712LegacyVerifier", book.EIP712LegacyVerifier?.address),
      },
      overrides: { gasPrice },
      fund: ethers.utils.parseEther("1"),
      // Local time: the fork jumps to the timestamp instead of waiting for it.
      waitUntil: async (t: number) => {
        if ((await provider.getBlock("latest")).timestamp >= t) return;
        await rpc("evm_setNextBlockTimestamp", [t]);
        await rpc("evm_mine");
      },
      networkName: `${net} fork`,
    });
    check(what, ok);
  };

  // ── 1. What the file describes is what is pending on chain ──────────────
  console.log("\nBefore:");
  const [pending, done, ts] = await Promise.all([timelock.isOperationPending(id), timelock.isOperationDone(id), timelock.getTimestamp(id)]);
  const eta: number = ts.toNumber();
  if (done && wantsSmoke) {
    console.log("  the operation has executed on the network: nothing is left to rehearse, and the fork is the state after it");
    await smokeB("the wave B smoke passes on a fork of the network after the real execution");
    return finish(checks);
  }
  check("the operation in the file is scheduled on chain and not yet executed", pending && !done, pending ? `eta ${new Date(eta * 1000).toISOString()}` : done ? "already executed" : "not scheduled");
  if (!pending || done) return finish(checks);

  // ── 2. What will be read before and after ───────────────────────────────
  const recorded: Record<string, string> = {};
  for (const [name, entry] of Object.entries<any>(book)) if (entry?.address) recorded[name] = ethers.utils.getAddress(entry.address);
  const watch: { name: string; artifact: string; address: string }[] = [
    { name: "UpgradeTimelock", artifact: "UpgradeTimelock", address: timelockAddr },
  ];
  for (const [name, address] of Object.entries(recorded)) {
    if (!targets.some((t) => same(t, address)) && !calls.some((c) => c.data.toLowerCase().includes(address.slice(2).toLowerCase()))) continue;
    if (name === "UpgradeTimelock" || !(await artifacts.artifactExists(name))) continue;
    watch.push({ name, artifact: name, address });
  }
  for (const item of (process.env.REHEARSE_WATCH ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [artifact, address] = item.split("@");
    watch.push({ name: `${artifact}@${address.slice(0, 8)}`, artifact, address: ethers.utils.getAddress(address) });
  }
  console.log(`  reading every getter of: ${watch.map((w) => w.name).join(", ")}; and the implementation of every recorded proxy`);
  const before = await snapshot(watch, recorded);

  // ── 3. Locked until the eta, open to anyone after ───────────────────────
  const executeData = isBatch
    ? timelock.interface.encodeFunctionData("executeBatch", [targets, values, datas, ZERO32, salt])
    : timelock.interface.encodeFunctionData("execute", [targets[0], 0, datas[0], ZERO32, salt]);
  await rpc("hardhat_impersonateAccount", [ANYONE]);
  await rpc("hardhat_setBalance", [ANYONE, "0xde0b6b3a7640000"]);
  const anyone = provider.getSigner(ANYONE);
  if (forkBlock.timestamp < eta) {
    // The raw request: ethers v5 hands a revert back as return data instead of throwing.
    let early = "the call went through";
    try {
      await rpc("eth_call", [{ from: ANYONE, to: timelockAddr, data: executeData }, "latest"]);
    } catch (e: any) {
      const said = String(e?.message ?? e);
      early = /TimelockUnexpectedOperationState|operation is not ready/.test(said) ? "" : `refused, but not by the timelock's own check: ${said.slice(0, 200)}`;
    }
    check("executing before the eta is refused by the timelock", early === "", early);
    await rpc("evm_setNextBlockTimestamp", [eta]);
  } else {
    console.log("  (the eta has passed on the network: executable now)");
  }

  console.log("\nExecution, from an address with no role:");
  let gasUsed = "";
  try {
    const tx = await anyone.sendTransaction({ to: timelockAddr, data: executeData });
    const receipt = await tx.wait();
    gasUsed = receipt.gasUsed.toString();
    check("the execution succeeds at the eta", receipt.status === 1, `gas used ${gasUsed}`);
  } catch (e: any) {
    check("the execution succeeds at the eta", false, String(e?.reason ?? e?.message ?? e).slice(0, 300));
    return finish(checks);
  }
  check("the timelock records the operation as done", await timelock.isOperationDone(id));

  // ── 4. What changed ─────────────────────────────────────────────────────
  const after = await snapshot(watch, recorded);
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).sort();
  console.log(`\nChanged by the execution (${changed.length} of ${Object.keys(after).length} values read):`);
  for (const k of changed) console.log(`  ${k}\n      before ${before[k] ?? "(absent)"}\n      after  ${after[k] ?? "(absent)"}`);
  if (changed.length === 0) console.log("  nothing");

  // ── 5. Optional: the train's smoke on the fork ──────────────────────────
  if (wantsSmoke) await smokeB("the wave B smoke passes on the fork after the execution");

  finish(checks, gasUsed);
}

function finish(checks: { what: string; ok: boolean }[], gasUsed = "") {
  const failed = checks.filter((c) => !c.ok);
  console.log(
    failed.length === 0
      ? gasUsed
        ? `\nRehearsal passed (${checks.length} checks, execution gas ${gasUsed}). Read the changed values above: they are what the real execution will do.`
        : `\nPassed (${checks.length} check${checks.length === 1 ? "" : "s"}), with no execution rehearsed.`
      : `\nRehearsal FAILED: ${failed.map((c) => c.what).join("; ")}`
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
