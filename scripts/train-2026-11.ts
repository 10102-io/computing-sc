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
 * batch (no transaction; reads the router live and writes the file):
 *   a: output/train-2026-11-wave-a-<network>.json
 *      [0] DefaultProxyAdmin.upgrade(TransferEOALegacyRouter, pending impl)
 *      [1] router.initializeV4(governance Safe, Payment or 0)
 *      [2] router.setLegacyImplementation(new clone implementation)
 *      [3] router.setPullVault(LegacyPullVaultV2)
 *      [4] DefaultProxyAdmin.upgrade(TimeLockRouter, pending impl)
 *      [5] DefaultProxyAdmin.upgrade(PremiumRegistry, pending impl)
 *      [6] DefaultProxyAdmin.upgrade(PremiumSetting, pending impl)
 *      [7] DefaultProxyAdmin.upgrade(EIP712LegacyVerifier, pending impl)
 *      [8] router.setActivityAttestor(TRAIN_ATTESTOR), only when set
 *   b: output/train-2026-11-wave-b-<network>.json
 *      [0] LegacyPullVaultV2.allowImplementation(TransferEOALegacyV3)
 *      [1] router.setLegacyImplementation(TransferEOALegacyV3)
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
  if (!["a", "b"].includes(wave) || !["deploy", "batch"].includes(action)) {
    throw new Error("Set TRAIN_WAVE=a|b and TRAIN_ACTION=deploy|batch");
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
  const items: Array<Record<string, string>> = [];
  if (wave === "a") {
    const safe = need(net.governance?.safe, "governance.safe");
    const clone = need(train.TransferEOALegacyImpl, "train202611.TransferEOALegacyImpl");
    const vault = need(train.LegacyPullVaultV2, "train202611.LegacyPullVaultV2");
    for (const n of ["TransferEOALegacyRouter", "TimeLockRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"]) {
      need(net[n]?.pendingImplementation, `${n}.pendingImplementation (run deploy-impl.ts)`);
    }
    // Sepolia's router still points at an orphan Payment; repoint it to the
    // recorded one. Mainnet already matches, so 0 leaves it untouched.
    const live = await ethers.getContractAt("TransferEOALegacyRouter", routerProxy);
    const livePayment = ethers.utils.getAddress(await live.paymentContract());
    const recordedPayment = need(net.Payment?.address, "Payment");
    const payment = livePayment === recordedPayment ? ethers.constants.AddressZero : recordedPayment;
    console.log(`Payment: live ${livePayment}, recorded ${recordedPayment} -> initializeV4 arg ${payment}`);

    items.push({ proxy: "TransferEOALegacyRouter", impl: net.TransferEOALegacyRouter.pendingImplementation });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("initializeV4", [safe, payment]), label: `router.initializeV4(${safe}, ${payment})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setLegacyImplementation", [clone]), label: `router.setLegacyImplementation(${clone})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setPullVault", [vault]), label: `router.setPullVault(${vault})` });
    for (const n of ["TimeLockRouter", "PremiumRegistry", "PremiumSetting", "EIP712LegacyVerifier"]) {
      items.push({ proxy: n, impl: net[n].pendingImplementation });
    }
    if (process.env.TRAIN_ATTESTOR) {
      const attestor = need(process.env.TRAIN_ATTESTOR, "TRAIN_ATTESTOR");
      items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setActivityAttestor", [attestor]), label: `router.setActivityAttestor(${attestor})` });
    }
  } else {
    const vault = need(train.LegacyPullVaultV2, "train202611.LegacyPullVaultV2");
    const v3 = need(train.TransferEOALegacyV3Impl, "train202611.TransferEOALegacyV3Impl");
    const V = await ethers.getContractFactory("LegacyPullVaultV2");
    items.push({ target: vault, data: V.interface.encodeFunctionData("allowImplementation", [v3]), label: `vault2.allowImplementation(${v3})` });
    items.push({ target: routerProxy, data: R.interface.encodeFunctionData("setLegacyImplementation", [v3]), label: `router.setLegacyImplementation(${v3})` });
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
