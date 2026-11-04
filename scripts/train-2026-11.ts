/**
 * The 2026-11 contract train (docs/plans/train-2026-11.md): deploys the
 * non-proxy contracts and writes each wave's single TL_BATCH file. Proxy
 * implementations are deployed by scripts/deploy-impl.ts first.
 *
 *   TRAIN_WAVE   = a | b
 *   TRAIN_ACTION = deploy | batch
 *
 * deploy (sends deploy transactions from the deployer, nothing else):
 *   a: TransferEOALegacy (the new clone implementation) and LegacyPullVaultV2
 *      (router proxy, UpgradeTimelock, that implementation); Etherscan-verified.
 *   b: NftCollectionWhiteList (deployer admin) and TransferEOALegacyV3.
 *   Recorded under `train202611` in contract-addresses.json, never over the
 *   live entries (they move when the batch has executed).
 *
 * batch (no transaction): runs the pre-schedule assertions (proxy admin owned
 * by the timelock; vault2's router and timelock; the new router
 * implementation's timelock; code at every address; mainnet Payment argument
 * 0 unless TRAIN_PAYMENT is set) and, only if all pass, writes the file:
 *   a: output/train-2026-11-wave-a-<network>.json
 *      [0] DefaultProxyAdmin.upgrade(TransferEOALegacyRouter, pending impl)
 *      [1] router.initializeV4(governance Safe, Payment or 0)
 *      [2] router.setLegacyImplementation(new clone implementation)
 *      [3] router.setPullVault(LegacyPullVaultV2)
 *      [4] DefaultProxyAdmin.upgrade(TimeLockRouter, pending impl)
 *      [5] DefaultProxyAdmin.upgrade(PremiumRegistry, pending impl)
 *      [6] DefaultProxyAdmin.upgrade(PremiumSetting, pending impl)
 *      [7] DefaultProxyAdmin.upgrade(EIP712LegacyVerifier, pending impl)
 *   b: output/train-2026-11-wave-b-<network>.json
 *      [0] LegacyPullVaultV2.allowImplementation(TransferEOALegacyV3)
 *      [1] router.setLegacyImplementation(TransferEOALegacyV3)
 *
 * check: the same assertions, nothing written; run it right before print and
 * schedule.
 *
 * Then: $env:TL_ACTION="print"; $env:TL_BATCH="<file>"; npx hardhat run scripts/timelock-op.ts --network <net>
 */
import * as fs from "fs";
import * as path from "path";
import * as hre from "hardhat";
import { ethers, network } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts, shouldVerify, sleep } from "./utils";

dotenv.config();

const BOOK_PATH = path.join(__dirname, "..", "contract-addresses.json");

function book(): any {
  const all = getContracts() as any;
  const net = all[network.name];
  if (!net) throw new Error(`No addresses for ${network.name}`);
  return { all, net };
}

function record(key: string, value: string) {
  const { all, net } = book();
  net.train202611 = { ...(net.train202611 ?? {}), [key]: value };
  all[network.name] = net;
  fs.writeFileSync(BOOK_PATH, JSON.stringify(all, null, 2) + "\n");
  console.log(`  recorded ${network.name}.train202611.${key} = ${value}`);
}

async function deployAndVerify(name: string, args: unknown[]): Promise<string> {
  const factory = await ethers.getContractFactory(name);
  const c = await factory.deploy(...args);
  console.log(`${name}: tx ${c.deployTransaction.hash}`);
  await c.deployTransaction.wait(network.name === "hardhat" || network.name === "localhost" ? 1 : 2);
  console.log(`${name}: ${c.address}`);
  if (shouldVerify(network.name)) {
    await sleep(15_000);
    try {
      await hre.run("verify:verify", { address: c.address, constructorArguments: args });
    } catch (e: any) {
      console.warn(`${name}: verify failed or already verified: ${e?.message ?? e}`);
    }
  }
  return c.address;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`Missing ${what}`);
  return ethers.utils.getAddress(v);
}

async function main() {
  const wave = (process.env.TRAIN_WAVE ?? "").toLowerCase();
  const action = (process.env.TRAIN_ACTION ?? "").toLowerCase();
  if (!["a", "b"].includes(wave) || !["deploy", "batch", "check"].includes(action)) {
    throw new Error("Set TRAIN_WAVE=a|b and TRAIN_ACTION=deploy|batch|check");
  }
  const { net } = book();
  const routerProxy = need(net.TransferEOALegacyRouter?.address, "TransferEOALegacyRouter proxy");
  const timelock = need(net.UpgradeTimelock?.address, "UpgradeTimelock");
  const train = net.train202611 ?? {};

  if (action === "deploy") {
    const [deployer] = await ethers.getSigners();
    console.log(`Network ${network.name}, deployer ${deployer.address}`);
    if (wave === "a") {
      const impl = await deployAndVerify("TransferEOALegacy", []);
      record("TransferEOALegacyImpl", impl);
      const vault = await deployAndVerify("LegacyPullVaultV2", [routerProxy, timelock, impl]);
      record("LegacyPullVaultV2", vault);
    } else {
      need(train.LegacyPullVaultV2, "train202611.LegacyPullVaultV2 (wave A first)");
      const list = await deployAndVerify("NftCollectionWhiteList", [deployer.address]);
      record("NftCollectionWhiteList", list);
      const v3 = await deployAndVerify("TransferEOALegacyV3", [list]);
      record("TransferEOALegacyV3Impl", v3);
    }
    console.log(`Next: TRAIN_ACTION=batch`);
    return;
  }

  const R = await ethers.getContractFactory("TransferEOALegacyRouter");
  const V = await ethers.getContractFactory("LegacyPullVaultV2");
  const items: Array<Record<string, string>> = [];
  const failures: string[] = [];
  const assert = (ok: boolean, what: string) => {
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const hasCode = async (a: string) => (await ethers.provider.getCode(a)) !== "0x";
  const vaultAddr = need(train.LegacyPullVaultV2, "train202611.LegacyPullVaultV2");
  const vault = V.attach(vaultAddr);
  const proxyAdmin = new ethers.Contract(
    need(net.DefaultProxyAdmin?.address, "DefaultProxyAdmin"),
    ["function owner() view returns (address)"],
    ethers.provider
  );

  console.log("Pre-schedule assertions:");
  assert(same(await proxyAdmin.owner(), timelock), "DefaultProxyAdmin.owner() is the UpgradeTimelock");
  assert(same(await vault.router(), routerProxy), "vault2.router() is the EOA router proxy");
  assert(same(await vault.upgradeTimelock(), timelock), "vault2.upgradeTimelock() is the UpgradeTimelock");

  if (wave === "a") {
    const safe = need(net.governance?.safe, "governance.safe");
    const clone = need(train.TransferEOALegacyImpl, "train202611.TransferEOALegacyImpl");
    const names = ["TransferEOALegacyRouter", "TimeLockRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"];
    for (const n of names) {
      const impl = need(net[n]?.pendingImplementation, `${n}.pendingImplementation (run deploy-impl.ts)`);
      assert(await hasCode(impl), `${n} pending implementation ${impl} has code`);
    }
    const routerImpl = R.attach(net.TransferEOALegacyRouter.pendingImplementation);
    assert(same(await routerImpl.upgradeTimelock(), timelock), "new router implementation's upgradeTimelock() is the UpgradeTimelock");
    assert(await hasCode(clone), `clone implementation ${clone} has code`);
    assert((await vault.cloneCodehash()) === (await vault.codehashOf(clone)), "vault2 pins the new clone implementation");
    assert(await hasCode(safe), `governance Safe ${safe} has code`);

    // initializeV4's Payment argument: 0 (unchanged) on mainnet unless
    // TRAIN_PAYMENT says otherwise; on Sepolia the recorded Payment when the
    // router still points at the orphan.
    const live = await ethers.getContractAt("TransferEOALegacyRouter", routerProxy);
    const livePayment = ethers.utils.getAddress(await live.paymentContract());
    const recordedPayment = need(net.Payment?.address, "Payment");
    const explicit = process.env.TRAIN_PAYMENT;
    const payment = explicit
      ? need(explicit, "TRAIN_PAYMENT")
      : network.name === "mainnet" || livePayment === recordedPayment
        ? ethers.constants.AddressZero
        : recordedPayment;
    console.log(`  Payment: live ${livePayment}, recorded ${recordedPayment}, initializeV4 argument ${payment}`);
    if (network.name === "mainnet") {
      assert(payment === ethers.constants.AddressZero || Boolean(explicit), "mainnet Payment argument is 0 unless TRAIN_PAYMENT is set");
    }
    if (payment !== ethers.constants.AddressZero) assert(await hasCode(payment), `Payment ${payment} has code`);

    items.push({ proxy: "TransferEOALegacyRouter", impl: net.TransferEOALegacyRouter.pendingImplementation });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("initializeV4", [safe, payment]), label: `router.initializeV4(${safe}, ${payment})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setLegacyImplementation", [clone]), label: `router.setLegacyImplementation(${clone})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setPullVault", [vaultAddr]), label: `router.setPullVault(${vaultAddr})` });
    for (const n of names.slice(1)) items.push({ proxy: n, impl: net[n].pendingImplementation });
  } else {
    const v3 = need(train.TransferEOALegacyV3Impl, "train202611.TransferEOALegacyV3Impl");
    const list = need(train.NftCollectionWhiteList, "train202611.NftCollectionWhiteList");
    const live = await ethers.getContractAt("TransferEOALegacyRouter", routerProxy);
    let routerTimelock = "";
    try {
      routerTimelock = await live.upgradeTimelock();
    } catch {
      /* pre-train router */
    }
    assert(same(routerTimelock || "0x", timelock), "wave A executed: the router pins the UpgradeTimelock");
    assert(same(await live.pullVault(), vaultAddr), "wave A executed: the router uses vault2");
    assert(!(await vault.isAllowedCodehash(await vault.codehashOf(v3))), "vault2 does not allow v3 yet");
    const V3 = await ethers.getContractFactory("TransferEOALegacyV3");
    assert(same(await V3.attach(v3).nftAllowlist(), list), "v3 implementation's nftAllowlist() is the recorded list");
    items.push({ target: vaultAddr, data: V.interface.encodeFunctionData("allowImplementation", [v3]), label: `vault2.allowImplementation(${v3})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setLegacyImplementation", [v3]), label: `router.setLegacyImplementation(${v3})` });
  }

  if (failures.length) throw new Error(`${failures.length} assertion(s) failed; nothing written. Fix and rerun.`);
  if (action === "check") {
    console.log("All assertions pass. Safe to print and schedule the batch file written by TRAIN_ACTION=batch.");
    return;
  }

  const outDir = path.join(__dirname, "..", "output");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `train-2026-11-wave-${wave}-${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
  items.forEach((it, i) => console.log(`  [${i}] ${it.label ?? `upgrade ${it.proxy} -> ${it.impl}`}`));
  console.log(`\nWrote ${path.relative(process.cwd(), file)}`);
  console.log(`Next: $env:TL_ACTION="print"; $env:TL_BATCH="${path.relative(process.cwd(), file)}"; npx hardhat run scripts/timelock-op.ts --network ${network.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
