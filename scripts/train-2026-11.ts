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
 * batch (no transaction): runs the pre-schedule assertions and, only if all
 * pass, writes the file. Assertions: the router's live code admin is the
 * recorded one (governance.eoaRouterCodeAdmin before wave A, the Safe before
 * wave B) and its initializer counter fits; the proxy admin is owned by the
 * timelock; every pending implementation, the new clone, vault2 (and in wave
 * B the v3 implementation and the list) run the compiled code, immutables
 * masked; vault2's router and timelock; the new router implementation's
 * timelock; Payment: on mainnet TRAIN_PAYMENT may only be unset or the
 * recorded Payment, and on every network the router's Payment after the
 * batch is the recorded one.
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
 * check: the same assertions, nothing written, and the written file must
 * equal the batch they build, item for item; run it right before print and
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
import { compileAgainstLive, readEoaRouterAdmin } from "./utils/live-code";

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
  // After wave A's A8 the vault is the recorded LegacyPullVault; the batch
  // still checks that it runs the compiled LegacyPullVaultV2.
  const vault2 = train.LegacyPullVaultV2 ?? (train.TransferEOALegacyImpl ? undefined : net.LegacyPullVault?.address);

  if (action === "deploy") {
    const [deployer] = await ethers.getSigners();
    console.log(`Network ${network.name}, deployer ${deployer.address}`);
    if (wave === "a") {
      const impl = await deployAndVerify("TransferEOALegacy", []);
      record("TransferEOALegacyImpl", impl);
      const vault = await deployAndVerify("LegacyPullVaultV2", [routerProxy, timelock, impl]);
      record("LegacyPullVaultV2", vault);
    } else {
      need(vault2, "LegacyPullVaultV2 (wave A first)");
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
  const isCompiled = async (contractName: string, address: string) => (await compileAgainstLive(contractName, address)).matches;
  const zero = ethers.constants.AddressZero;

  console.log("Pre-schedule assertions:");

  // Who controls the router right now. Sepolia sits at counter 3, where the
  // live implementation's ungated initializeV3 still lets anyone set the code
  // admin until this batch runs; mainnet is at 4 (closed).
  const admin = await readEoaRouterAdmin(routerProxy);
  console.log(`  EOA router ${routerProxy}: implementation ${admin.implementation}, initializer counter ${admin.counter}, code admin ${admin.codeAdmin}`);
  const expectedAdmin =
    wave === "a"
      ? need(net.governance?.eoaRouterCodeAdmin, "governance.eoaRouterCodeAdmin")
      : need(net.governance?.safe, "governance.safe");
  assert(same(admin.codeAdmin, expectedAdmin), `code admin is the expected ${wave === "a" ? "pre-train key" : "governance Safe"} ${expectedAdmin}`);
  assert(
    wave === "a" ? admin.counter === 3 || admin.counter === 4 : admin.counter === 5,
    wave === "a" ? "initializer counter is 3 or 4 (initializeV4 is reinitializer 5)" : "initializer counter is 5 (wave A executed)"
  );

  const vaultAddr = need(vault2, "LegacyPullVaultV2");
  const vault = V.attach(vaultAddr);
  const proxyAdmin = new ethers.Contract(
    need(net.DefaultProxyAdmin?.address, "DefaultProxyAdmin"),
    ["function owner() view returns (address)"],
    ethers.provider
  );
  assert(same(await proxyAdmin.owner(), timelock), "DefaultProxyAdmin.owner() is the UpgradeTimelock");
  assert(await isCompiled("LegacyPullVaultV2", vaultAddr), `vault2 ${vaultAddr} runs the compiled LegacyPullVaultV2`);
  assert(same(await vault.router(), routerProxy), "vault2.router() is the EOA router proxy");
  assert(same(await vault.upgradeTimelock(), timelock), "vault2.upgradeTimelock() is the UpgradeTimelock");

  if (wave === "a") {
    const safe = need(net.governance?.safe, "governance.safe");
    const clone = need(train.TransferEOALegacyImpl, "train202611.TransferEOALegacyImpl");
    const names = ["TransferEOALegacyRouter", "TimeLockRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"];
    for (const n of names) {
      const impl = need(net[n]?.pendingImplementation, `${n}.pendingImplementation (run deploy-impl.ts)`);
      assert(await isCompiled(n, impl), `${n} pending implementation ${impl} runs the compiled ${n}`);
    }
    const routerImpl = R.attach(net.TransferEOALegacyRouter.pendingImplementation);
    assert(same(await routerImpl.upgradeTimelock(), timelock), "new router implementation's upgradeTimelock() is the UpgradeTimelock");
    assert(await isCompiled("TransferEOALegacy", clone), `clone implementation ${clone} runs the compiled TransferEOALegacy`);
    assert((await vault.cloneCodehash()) === (await vault.codehashOf(clone)), "vault2 pins the new clone implementation");
    assert((await ethers.provider.getCode(safe)) !== "0x", `governance Safe ${safe} has code`);

    // initializeV4's Payment argument. Mainnet: 0 (unchanged); TRAIN_PAYMENT
    // may only be unset or the recorded mainnet Payment. Elsewhere: the
    // recorded Payment when the router points at another one. Either way the
    // router's Payment after the batch must be the recorded one.
    const live = await ethers.getContractAt("TransferEOALegacyRouter", routerProxy);
    const livePayment = ethers.utils.getAddress(await live.paymentContract());
    const recordedPayment = need(net.Payment?.address, "Payment");
    const explicit = process.env.TRAIN_PAYMENT;
    // PowerShell $env: values persist across commands: say what is set.
    console.log(`  TRAIN_PAYMENT is ${explicit === undefined || explicit === "" ? "unset" : `set to ${explicit}`}`);
    let payment = zero;
    if (network.name === "mainnet") {
      assert(!explicit || same(explicit, recordedPayment), `mainnet: TRAIN_PAYMENT is unset or the recorded Payment ${recordedPayment}`);
      if (explicit && same(explicit, recordedPayment) && !same(livePayment, recordedPayment)) payment = recordedPayment;
    } else if (explicit) {
      payment = need(explicit, "TRAIN_PAYMENT");
    } else if (!same(livePayment, recordedPayment)) {
      payment = recordedPayment;
    }
    const after = payment === zero ? livePayment : payment;
    console.log(`  Payment: live ${livePayment}, recorded ${recordedPayment}; initializeV4 argument ${payment}; after the batch ${after}`);
    assert(same(after, recordedPayment), `the router's Payment after the batch is the recorded ${recordedPayment}`);

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
    assert(await isCompiled("TransferEOALegacyV3", v3), `v3 implementation ${v3} runs the compiled TransferEOALegacyV3`);
    assert(await isCompiled("NftCollectionWhiteList", list), `list ${list} runs the compiled NftCollectionWhiteList`);
    assert(!(await vault.isAllowedCodehash(await vault.codehashOf(v3))), "vault2 does not allow v3 yet");
    const V3 = await ethers.getContractFactory("TransferEOALegacyV3");
    assert(same(await V3.attach(v3).nftAllowlist(), list), "v3 implementation's nftAllowlist() is the recorded list");
    items.push({ target: vaultAddr, data: V.interface.encodeFunctionData("allowImplementation", [v3]), label: `vault2.allowImplementation(${v3})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setLegacyImplementation", [v3]), label: `router.setLegacyImplementation(${v3})` });
  }

  const outDir = path.join(__dirname, "..", "output");
  const file = path.join(outDir, `train-2026-11-wave-${wave}-${network.name}.json`);
  const rel = path.relative(process.cwd(), file);
  if (action === "check") {
    // The file the Safe will schedule must be exactly what these assertions built.
    const norm = (list: Array<Record<string, string>>) =>
      JSON.stringify(list.map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, String(v).toLowerCase()]))));
    if (!fs.existsSync(file)) {
      assert(false, `${rel} exists (run TRAIN_ACTION=batch first)`);
    } else {
      const written: Array<Record<string, string>> = JSON.parse(fs.readFileSync(file, "utf-8"));
      const n = Math.max(written.length, items.length);
      for (let i = 0; i < n; i++) {
        if (norm([written[i] ?? {}]) !== norm([items[i] ?? {}])) {
          console.log(`  item ${i}: file ${JSON.stringify(written[i])}\n          expected ${JSON.stringify(items[i])}`);
        }
      }
      assert(norm(written) === norm(items), `${rel} matches the batch these assertions build, item for item`);
    }
  }

  if (failures.length) throw new Error(`${failures.length} assertion(s) failed; nothing written. Fix and rerun.`);
  if (action === "check") {
    console.log(`All assertions pass and ${rel} matches. Safe to print and schedule it.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
  items.forEach((it, i) => console.log(`  [${i}] ${it.label ?? `upgrade ${it.proxy} -> ${it.impl}`}`));
  console.log(`\nWrote ${rel}`);
  console.log(`Next: $env:TRAIN_ACTION="check" (same network), then $env:TL_ACTION="print"; $env:TL_BATCH="${rel}"; npx hardhat run scripts/timelock-op.ts --network ${network.name}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
