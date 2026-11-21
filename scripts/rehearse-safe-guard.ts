/**
 * Walks the Safe legacy change against a network's Safe legacies, on a local
 * fork: nothing is sent to a real network and no key is needed. It is the
 * check to run BEFORE the two implementations are deployed and scheduled
 * (rehearse-timelock-op.ts rehearses the scheduled operation afterwards).
 *
 * The change (2026-11):
 *   - LegacyDeployer carries guard version 2 and deploys for the routers
 *     only. Version 2 moves a legacy's clock when the Safe executes a
 *     transaction, or when anyone has a transaction counted that the guard
 *     did not see (`sync`, by the Safe's nonce). Version 1 also took a
 *     direct call with signatures it never checked against the Safe's
 *     owners.
 *   - MultisigLegacyRouter activates a legacy only while it is set up on its
 *     Safe (its guard is the Safe's guard, the legacy an enabled module) and
 *     the guard has seen the Safe's last transaction; its check answers
 *     false for a legacy that was activated; its setters take the legacy's
 *     own Safe only. A new legacy skips a beneficiary who is an owner of the
 *     Safe already instead of failing.
 * Guards and legacies are not upgradeable: a legacy created before keeps its
 * version 1 guard, and the router's rules are the only part that reaches it.
 *
 * The walk:
 *   1. swaps both implementations as the proxy admin's owner (the timelock,
 *      impersonated); every zero-argument getter, every legacy's record, the
 *      first storage slots and the address the EOA router announces for a
 *      next legacy must read the same before and after;
 *   2. for every legacy that exists: whether it can be activated, before and
 *      after. The only change allowed is true -> false on a legacy that is
 *      not set up on its Safe or was activated already;
 *   3. on a copy of the state, every legacy that exists and is still set up
 *      on its Safe activates after its wait under the new router, and its
 *      Safe (impersonated) still renames it while a contract that answers
 *      the router's questions like that Safe is refused;
 *   4. a new Safe of each version (1.3.0, 1.4.1 and 1.5.0, from the canonical
 *      factory) creates a legacy through the router and sets it up with the
 *      app's batch. Each refusal is checked by its error, never by "it
 *      reverted": not set up, a day early, guard off, guard set again and
 *      behind. A stranger's calls move nothing (the same call moves a
 *      version 1 guard of this network), and the legacy activates after
 *      the wait;
 *   5. the EOA router, which shares the LegacyDeployer, still creates: the
 *      wave B smoke (scripts/smoke-train-2026-11-b.ts) runs on the fork.
 *
 * Env (hardhat run forwards no CLI args):
 *   WALK_NETWORK  = mainnet | sepolia   (default mainnet)
 *   WALK_BLOCK    = block to fork at (default: the network's head). Once the
 *                   upgrade has executed on the network, nothing is swapped
 *                   and the walk is of the live implementations
 *   WALK_SMOKE_AS = address the EOA smoke runs as, impersonated on the fork
 *                   (default the maintainer address, which holds the
 *                   operator roles the smoke's premium and NFT legs use)
 *
 * PowerShell:
 *   npx hardhat run scripts/rehearse-safe-guard.ts
 */
import { BigNumber } from "ethers";
import { ethers, network, artifacts } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";
import { revertedWith } from "../test/utils/revert";

dotenv.config();

// ethers v5 at runtime; the installed typings describe v6 (as in the other scripts).
const provider = ethers.provider as any;
const rpc = (method: string, params: unknown[] = []) => network.provider.request({ method, params });
const slotOf = (name: string) => ethers.utils.hexZeroPad(BigNumber.from(ethers.utils.id(name)).sub(1).toHexString(), 32);
const IMPL_SLOT = slotOf("eip1967.proxy.implementation");
const ADMIN_SLOT = slotOf("eip1967.proxy.admin");
const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const asAddress = (word: string) => ethers.utils.getAddress("0x" + word.slice(26));
const ZERO = ethers.constants.AddressZero;
const DAY = 86400;
const WAIT = 30 * DAY;
const MAINTAINER = "0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630";

// The canonical Safe deployments (the same addresses on mainnet and Sepolia).
const SAFES = {
  "1.3.0": {
    singleton: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
    factory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
    fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
    multiSendCallOnly: "0x40A2aCCbd92BCA938b02010E17A5b8929b49130D",
  },
  "1.4.1": {
    singleton: "0x41675C099F32341bf84BFc5382aF534df5C7461a",
    factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
    fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
    multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
  },
  "1.5.0": {
    singleton: "0xFf51A5898e281Db6DfC7855790607438dF2ca44b",
    factory: "0x14F2982D601c9458F93bd70B218933A6f8165e7b",
    fallbackHandler: "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4",
    multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
  },
} as const;

const SAFE_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function isModuleEnabled(address module) view returns (bool)",
  "function enableModule(address module)",
  "function setGuard(address guard)",
  "function VERSION() view returns (string)",
];
const FACTORY_ABI = ["function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)"];
const MULTISEND = new ethers.utils.Interface(["function multiSend(bytes transactions)"]);
const GUARD_ABI = [
  "function GUARD_VERSION() view returns (uint256)",
  "function safeWallet() view returns (address)",
  "function getLastTimestampTxs() view returns (uint256)",
  "function lastNonce() view returns (uint256)",
  "function sync()",
  "function checkTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, address msgSender)",
];
const GUARD = new ethers.utils.Interface(GUARD_ABI);
const LEGACY_ABI = [
  "function isLive() view returns (bool)",
  "function getLegacyOwner() view returns (address)",
  "function getBeneficiaries() view returns (address[])",
  "function getMinRequiredSignatures() view returns (uint128)",
  "function getActivationTrigger() view returns (uint256)",
  "function safeGuard() view returns (address)",
];
const VERIFIER_ABI = ["function generateVersionedMessage(uint256 timestamp) view returns (string)"];

type SafeTx = { to: string; data?: string; operation?: number };
type Call = { to: string; data: string };
const txArgs = (tx: SafeTx) => [tx.to, 0, tx.data ?? "0x", tx.operation ?? 0, 0, 0, 0, ZERO, ZERO] as const;
/** Raw signatures over a Safe transaction hash, in the ascending signer order the Safe asks for. */
function signHash(hash: string, wallets: any[]): string {
  const sorted = [...wallets].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
  return ethers.utils.hexConcat(sorted.map((w) => ethers.utils.joinSignature(w._signingKey().signDigest(hash))));
}
const strangers = () => [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
/** An address as the walk prints it: a Safe is a user's, so never in full. */
const brief = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function main() {
  if (network.name !== "hardhat") throw new Error("The walk runs on the in-process hardhat network only (no --network).");
  const net = (process.env.WALK_NETWORK ?? "mainnet").toLowerCase();
  const url = net === "mainnet" ? process.env.MAINNET_RPC_URL : net === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
  if (!url) throw new Error(`Set ${net === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"} in .env (WALK_NETWORK is mainnet or sepolia).`);
  const book: any = (getContracts() as any)[net];
  const routerAddr: string | undefined = book?.MultisigLegacyRouter?.address;
  const deployerAddr: string | undefined = book?.LegacyDeployer?.address;
  const eoaRouterAddr: string | undefined = book?.TransferEOALegacyRouter?.address;
  const timelockAddr: string | undefined = book?.UpgradeTimelock?.address;
  if (!routerAddr || !deployerAddr || !eoaRouterAddr || !timelockAddr) throw new Error(`A router, LegacyDeployer or UpgradeTimelock is not recorded for ${net}.`);

  // The head is asked for and named: left alone, Hardhat forks well behind
  // it (see rehearse-timelock-op.ts), before an upgrade that just executed.
  const head = process.env.WALK_BLOCK ? Number(process.env.WALK_BLOCK) : await new ethers.providers.StaticJsonRpcProvider(url).getBlockNumber();
  if (!Number.isInteger(head) || head <= 0) throw new Error("WALK_BLOCK must be a block number.");
  await rpc("hardhat_reset", [{ forking: { jsonRpcUrl: url, blockNumber: head } }]);
  const forkBlock = await provider.getBlock("latest");
  console.log(`Fork of ${net} at block ${forkBlock.number} (${new Date(forkBlock.timestamp * 1000).toISOString()}). Nothing here reaches ${net}.`);
  await rpc("evm_mine"); // reads before and after under the same chain id (see rehearse-timelock-op.ts)

  const as = async (who: string) => {
    await rpc("hardhat_impersonateAccount", [who]);
    await rpc("hardhat_setBalance", [who, "0x8ac7230489e80000"]); // 10 ETH, on the fork only
    return provider.getSigner(who);
  };
  const failures: string[] = [];
  const check = (what: string, ok: boolean, detail = "") => {
    if (!ok) failures.push(what);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
  };
  /** Whether the call reverts with this error (a custom error by its selector, a reason by its text). */
  const refused = async (call: Promise<unknown>, error: string) => {
    try {
      await call;
      return false;
    } catch (e) {
      return revertedWith(e, error);
    }
  };
  const now = async () => (await provider.getBlock("latest")).timestamp as number;
  const warp = async (seconds: number) => {
    await rpc("evm_increaseTime", [seconds]);
    await rpc("evm_mine");
  };
  const [funder, anyone] = await ethers.getSigners();

  // ── The two proxies as the network runs them ────────────────────────────
  const routerArtifact = await artifacts.readArtifact("MultisigLegacyRouter");
  const deployerArtifact = await artifacts.readArtifact("LegacyDeployer");
  const router = new ethers.Contract(routerAddr, routerArtifact.abi, provider);
  const deployer = new ethers.Contract(deployerAddr, deployerArtifact.abi, provider);
  const eoaRouter = new ethers.Contract(eoaRouterAddr, ["function getNextLegacyAddress(address sender_) view returns (address)"], provider);
  const proxyAdminAddr = asAddress(await provider.getStorageAt(routerAddr, ADMIN_SLOT));
  check("both proxies answer to one proxy admin", asAddress(await provider.getStorageAt(deployerAddr, ADMIN_SLOT)) === proxyAdminAddr, proxyAdminAddr);
  const proxyAdmin = new ethers.Contract(
    proxyAdminAddr,
    ["function owner() view returns (address)", "function upgrade(address proxy, address implementation)"],
    provider,
  );
  const adminOwner: string = await proxyAdmin.owner();
  if (adminOwner.toLowerCase() !== timelockAddr.toLowerCase()) throw new Error("The proxy admin's owner is not the recorded UpgradeTimelock.");
  const oldRouterImpl = asAddress(await provider.getStorageAt(routerAddr, IMPL_SLOT));
  const oldDeployerImpl = asAddress(await provider.getStorageAt(deployerAddr, IMPL_SLOT));
  console.log(`Router ${routerAddr} (implementation ${oldRouterImpl}), deployer ${deployerAddr} (implementation ${oldDeployerImpl}).`);
  check("the deployer serves this router", (await deployer.multisigLegacyRouter()).toLowerCase() === routerAddr.toLowerCase());
  check("the deployer serves the EOA router", (await deployer.transferEOALegacyRouter()).toLowerCase() === eoaRouterAddr.toLowerCase());
  const deployerOwner: string = await deployer.owner();

  // The router keeps its legacy count in slot 0 (LegacyFactory._legacyId, internal).
  const count = BigNumber.from(await provider.getStorageAt(routerAddr, 0)).toNumber();
  const getters = (abi: any[]) => abi.filter((f: any) => f.type === "function" && f.inputs.length === 0 && ["view", "pure"].includes(f.stateMutability));
  const probes = [MAINTAINER, "0x000000000000000000000000000000000000dEaD"];
  const readAll = async () => {
    const out: Record<string, string> = {};
    for (const [label, c, abi] of [["router", router, routerArtifact.abi], ["deployer", deployer, deployerArtifact.abi]] as const) {
      for (const g of getters(abi as any[])) {
        try {
          out[`${label}.${g.name}`] = String(await c[g.name]());
        } catch {
          out[`${label}.${g.name}`] = "(reverts)";
        }
      }
    }
    for (let id = 1; id <= count; id++) {
      out[`legacy ${id}`] = `${await router.legacyAddresses(id)} ${await router.guardAddresses(id)}`;
    }
    for (let slot = 0; slot < 8; slot++) {
      out[`router slot ${slot}`] = await provider.getStorageAt(routerAddr, slot);
      out[`deployer slot ${slot}`] = await provider.getStorageAt(deployerAddr, slot);
    }
    for (const who of probes) out[`next EOA legacy of ${brief(who)}`] = await eoaRouter.getNextLegacyAddress(who);
    return out;
  };

  // ── Every Safe legacy of the router, before ─────────────────────────────
  interface Row {
    id: number;
    legacy: string;
    guard: string;
    safe: string;
    live: boolean;
    setUp: boolean;
    ready: boolean | null;
    readyAt: number;
  }
  const rows: Row[] = [];
  for (let id = 1; id <= count; id++) {
    const legacy: string = await router.legacyAddresses(id);
    const guard: string = await router.guardAddresses(id);
    const l = new ethers.Contract(legacy, LEGACY_ABI, provider);
    const safe: string = await l.getLegacyOwner();
    const s = new ethers.Contract(safe, SAFE_ABI, provider);
    const g = new ethers.Contract(guard, GUARD_ABI, provider);
    const last: BigNumber = await g.getLastTimestampTxs();
    const guardOnSafe = asAddress(await provider.getStorageAt(safe, GUARD_SLOT)) === ethers.utils.getAddress(guard);
    rows.push({
      id,
      legacy,
      guard,
      safe,
      live: await l.isLive(),
      setUp: guardOnSafe && (await s.isModuleEnabled(legacy).catch(() => false)),
      ready: await router.checkActiveLegacy(id).catch(() => null),
      readyAt: last.add(await l.getActivationTrigger()).toNumber(),
    });
  }
  const live = rows.filter((r) => r.live);
  const candidates = live.filter((r) => r.setUp);
  console.log(`${count} Safe legacies, ${live.length} not yet activated; ${candidates.length} of those are set up on their Safe.`);
  const before = await readAll();

  // ── The swap, as the timelock ───────────────────────────────────────────
  // Once the upgrade has executed on the network, both proxies run the code
  // of this checkout already: then nothing is swapped and the walk is of
  // the implementations that are live.
  const executed =
    (await provider.getCode(oldRouterImpl)) === routerArtifact.deployedBytecode &&
    (await provider.getCode(oldDeployerImpl)) === deployerArtifact.deployedBytecode;
  let newDeployerImpl = new ethers.Contract(oldDeployerImpl, deployerArtifact.abi, provider);
  let newRouterImpl = new ethers.Contract(oldRouterImpl, routerArtifact.abi, provider);
  if (executed) {
    console.log(`\nThe upgrade has executed on ${net}: both proxies run this checkout's code, and the walk is of the live implementations.`);
  } else {
    // The implementations that wait in the timelock, when they are deployed
    // (recorded as pending, with this checkout's code); fresh ones otherwise.
    const pending = async (name: string, code: string) => {
      const at: string | undefined = book?.[name]?.pendingImplementation;
      return at && (await provider.getCode(at)) === code ? at : undefined;
    };
    const pendingDeployer = await pending("LegacyDeployer", deployerArtifact.deployedBytecode);
    const pendingRouter = await pending("MultisigLegacyRouter", routerArtifact.deployedBytecode);
    if (pendingDeployer && pendingRouter) {
      console.log(`\nThe implementations deployed on ${net} and waiting in the timelock are walked: deployer ${pendingDeployer}, router ${pendingRouter}.`);
      newDeployerImpl = new ethers.Contract(pendingDeployer, deployerArtifact.abi, provider);
      newRouterImpl = new ethers.Contract(pendingRouter, routerArtifact.abi, provider);
    } else {
      newDeployerImpl = await (await ethers.getContractFactory("LegacyDeployer", funder)).deploy();
      newRouterImpl = await (await ethers.getContractFactory("MultisigLegacyRouter", funder)).deploy();
    }
    const timelock = await as(timelockAddr);
    await (await proxyAdmin.connect(timelock).upgrade(deployerAddr, newDeployerImpl.address)).wait();
    await (await proxyAdmin.connect(timelock).upgrade(routerAddr, newRouterImpl.address)).wait();
    console.log("\nAfter the swap:");
  }
  check("the deployer runs the new implementation", asAddress(await provider.getStorageAt(deployerAddr, IMPL_SLOT)) === newDeployerImpl.address);
  check("the router runs the new implementation", asAddress(await provider.getStorageAt(routerAddr, IMPL_SLOT)) === newRouterImpl.address);
  const after = await readAll();
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  check(`${Object.keys(before).length} getters, records, storage slots and announced addresses read the same`, changed.length === 0, changed.join(", "));
  check("the new router implementation cannot be initialised", await refused(newRouterImpl.connect(anyone).callStatic.initialize(ZERO, ZERO, ZERO), "InvalidInitialization()"));
  check("the new deployer implementation cannot be initialised", await refused(newDeployerImpl.connect(anyone).callStatic.initialize(), "InvalidInitialization()"));
  check("the router cannot be initialised again", await refused(router.connect(anyone).callStatic.initialize(ZERO, ZERO, ZERO), "InvalidInitialization()"));
  check("the deployer cannot be initialised again", await refused(deployer.connect(anyone).callStatic.initialize(), "InvalidInitialization()"));
  const legacyCode = (await artifacts.readArtifact("MultisigLegacy")).bytecode;
  check(
    `the deployer's owner (${deployerOwner}) cannot deploy through it`,
    await refused(deployer.connect(await as(deployerOwner)).callStatic.createLegacy(legacyCode, MAINTAINER), "Router only"),
  );

  // ── Every legacy, after ─────────────────────────────────────────────────
  console.log("\nThe legacies that exist:");
  for (const r of rows) {
    const ready: boolean | null = await router.checkActiveLegacy(r.id).catch(() => null);
    // True stays true only for a legacy that is live and set up on its Safe.
    const expected = r.ready === null ? null : r.ready && r.setUp && r.live;
    const state = !r.live ? "activated" : r.setUp ? "set up on its Safe" : "not set up on its Safe";
    check(`#${r.id} (${state}): can be activated ${r.ready ?? "unreadable"} -> ${ready ?? "unreadable"}`, ready === expected || (r.ready === null && ready === false));
    if (!r.live) check(`#${r.id}: and activation is refused, as before (LegacyNotActive)`, await refused(router.connect(anyone).callStatic.activeLegacy(r.id), "LegacyNotActive()"));
    // What the router refuses now, by its error: the legacy is not set up on its Safe.
    if (r.live && !r.setUp && r.ready !== null) {
      const guardOnSafe = asAddress(await provider.getStorageAt(r.safe, GUARD_SLOT)) === ethers.utils.getAddress(r.guard);
      check(
        `#${r.id}: activation is refused because it is not set up`,
        await refused(router.connect(anyone).callStatic.activeLegacy(r.id), guardOnSafe ? "ModuleSafeWalletInvalid()" : "GuardSafeWalletInvalid()"),
      );
    }
  }

  // ── A legacy that exists still activates under the new router ───────────
  console.log(`\nActivation of ${candidates.length} existing legacies under the new router (each on a copy of the state):`);
  for (const r of candidates) {
    const snapshot = await rpc("evm_snapshot");
    try {
      const l = new ethers.Contract(r.legacy, LEGACY_ABI, provider);
      const s = new ethers.Contract(r.safe, SAFE_ABI, provider);
      const named: string[] = await l.getBeneficiaries();
      const required: number = (await l.getMinRequiredSignatures()).toNumber();
      const ownersBefore: string[] = await s.getOwners();
      const wait = r.readyAt - (await now());
      if (wait > 0) {
        check(`#${r.id}: refused ${Math.ceil(wait / DAY)} days early`, await refused(router.connect(anyone).callStatic.activeLegacy(r.id), "NotEnoughContitionalActive()"));
        await warp(wait + 1);
      }
      await (await router.connect(anyone).activeLegacy(r.id)).wait();
      const ownersAfter: string[] = await s.getOwners();
      const joined = named.every((b) => ownersAfter.includes(b)) && ownersBefore.every((o) => ownersAfter.includes(o));
      check(
        `#${r.id} (version 1 guard, Safe ${await s.VERSION()}): ${named.length} named join ${ownersBefore.length} owners, ${required} needed`,
        joined && ownersAfter.length === ownersBefore.length + named.length && (await s.getThreshold()).toNumber() === required && !(await l.isLive()),
      );
    } catch (e: any) {
      check(`#${r.id}: activates under the new router`, false, String(e?.message ?? e).slice(0, 140));
    }
    await rpc("evm_revert", [snapshot]);
  }

  // ── The Safe of a legacy still changes it; a contract that answers like it does not ──
  console.log("\nThe setters of the router, for the legacies that exist and are set up:");
  for (const r of candidates) {
    const snapshot = await rpc("evm_snapshot");
    const l = new ethers.Contract(r.legacy, [...LEGACY_ABI, "function getLegacyName() view returns (string)"], provider);
    const name: string = await l.getLegacyName();
    const lookalike = await (await ethers.getContractFactory("MockSafeLookalike", funder)).deploy(r.guard, r.legacy);
    const rename = router.interface.encodeFunctionData("setNameNote", [r.id, "not yours", "a note the owners never wrote"]);
    check(
      `#${r.id}: a contract that answers like its Safe cannot rename it (SenderIsNotSafeWalletOfLegacy)`,
      (await refused(lookalike.connect(anyone).callStatic.forward(routerAddr, rename), "SenderIsNotSafeWalletOfLegacy()")) && (await l.getLegacyName()) === name,
    );
    try {
      await (await router.connect(await as(r.safe)).setNameNote(r.id, `${name} (walk)`, "")).wait();
      check(`#${r.id}: its Safe renames it as before`, (await l.getLegacyName()) === `${name} (walk)`);
    } catch (e: any) {
      check(`#${r.id}: its Safe renames it as before`, false, String(e?.message ?? e).slice(0, 140));
    }
    await rpc("evm_revert", [snapshot]);
  }

  // ── A stranger moves a version 1 guard of this network ──────────────────
  const v1 = candidates[0];
  if (v1) {
    const snapshot = await rpc("evm_snapshot");
    const g = new ethers.Contract(v1.guard, GUARD_ABI, anyone);
    const s = new ethers.Contract(v1.safe, SAFE_ABI, provider);
    const tx: SafeTx = { to: v1.safe };
    // Version 1 hashes the Safe's previous nonce and then only asks that the recovered signers ascend.
    const hash: string = await s.getTransactionHash(...txArgs(tx), (await s.nonce()).sub(1));
    const threshold = (await s.getThreshold()).toNumber();
    const was = (await g.getLastTimestampTxs()).toNumber();
    await warp(DAY);
    const keys = Array.from({ length: threshold }, () => ethers.Wallet.createRandom());
    await (await g.checkTransaction(...txArgs(tx), signHash(hash, keys), anyone.address)).wait();
    const is = (await g.getLastTimestampTxs()).toNumber();
    check(`#${v1.id}: ${threshold} throwaway key${threshold > 1 ? "s" : ""} moved its version 1 clock (why a legacy created before is created again)`, is >= was + DAY);
    await rpc("evm_revert", [snapshot]);
  } else {
    check("a legacy on a version 1 guard is set up on its Safe here, to show a stranger moving it", false);
  }

  // ── A new Safe of each version, through the router ──────────────────────
  const verifier = new ethers.Contract(await router.verifier(), VERIFIER_ABI, provider);
  const safeInterface = new ethers.utils.Interface(SAFE_ABI);
  let created = 0;
  for (const version of Object.keys(SAFES) as (keyof typeof SAFES)[]) {
    console.log(`\nA new Safe ${version} and its legacy:`);
    const parts = SAFES[version];
    const missing = [];
    for (const [name, at] of Object.entries(parts)) if ((await provider.getCode(at)) === "0x") missing.push(name);
    if (missing.length) {
      check(`Safe ${version} is deployed on ${net}`, false, `no code at ${missing.join(", ")}`);
      continue;
    }
    const owners = [0, 1, 2].map(() => ethers.Wallet.createRandom().connect(provider));
    for (const o of owners) await rpc("hardhat_setBalance", [o.address, "0x8ac7230489e80000"]);
    const heirs = [ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address];
    const factory = new ethers.Contract(parts.factory, FACTORY_ABI, anyone);
    const setup = safeInterface.encodeFunctionData("setup", [owners.map((o) => o.address), 2, ZERO, "0x", parts.fallbackHandler, ZERO, 0, ZERO]);
    const salt = BigNumber.from(ethers.utils.randomBytes(8));
    const safeAddr: string = await factory.callStatic.createProxyWithNonce(parts.singleton, setup, salt);
    await (await factory.createProxyWithNonce(parts.singleton, setup, salt)).wait();
    const safe = new ethers.Contract(safeAddr, SAFE_ABI, provider);
    check(`a 2 of 3 Safe ${await safe.VERSION()} from the canonical factory`, (await safe.VERSION()) === version && (await safe.getThreshold()).toNumber() === 2);
    const exec = async (tx: SafeTx) => {
      const hash: string = await safe.getTransactionHash(...txArgs(tx), await safe.nonce());
      const receipt = await (await safe.connect(anyone).execTransaction(...txArgs(tx), signHash(hash, owners.slice(0, 2)))).wait();
      return { hash, at: (await provider.getBlock(receipt.blockNumber)).timestamp as number };
    };
    const onSafe = (fn: string, args: unknown[]): Call => ({ to: safeAddr, data: safeInterface.encodeFunctionData(fn, args) });
    const batch = (calls: Call[]): SafeTx => ({
      to: parts.multiSendCallOnly,
      operation: 1,
      data: MULTISEND.encodeFunctionData("multiSend", [
        ethers.utils.hexConcat(
          calls.map((c) => ethers.utils.solidityPack(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, 0, ethers.utils.hexDataLength(c.data), c.data])),
        ),
      ]),
    });

    // A Safe that has been used: its nonce is not zero when the legacy is created.
    await exec({ to: safeAddr });

    // An owner creates the legacy, with the terms message the network's verifier asks for.
    const ts = await now();
    const agreement = await owners[0].signMessage(await verifier.generateVersionedMessage(ts));
    const id = count + 1 + created;
    const legacyAddr: string = await router.getNextLegacyAddress(owners[0].address);
    await (
      await router
        .connect(owners[0])
        .createLegacy(safeAddr, { name: "walk", note: "", nickNames: ["one", "two"], beneficiaries: heirs }, { minRequiredSignatures: 2, lackOfOutgoingTxRange: WAIT }, ts, agreement)
    ).wait();
    created += 1;
    const createdAt = await now();
    check(`legacy #${id} is created where the router said`, (await router.legacyAddresses(id)) === legacyAddr);
    const guard = new ethers.Contract(await router.guardAddresses(id), GUARD_ABI, anyone);
    const clock = async () => (await guard.getLastTimestampTxs()).toNumber();
    const upToDate = async () => (await guard.lastNonce()).eq(await safe.nonce());
    const activation = () => router.connect(anyone).callStatic.activeLegacy(id);
    check("its guard is version 2 and bound to the Safe", (await guard.GUARD_VERSION()).toNumber() === 2 && (await guard.safeWallet()) === safeAddr);
    check("the clock starts at the creation, with the Safe's nonce (1) noted", (await clock()) === createdAt && (await upToDate()) && (await guard.lastNonce()).toNumber() === 1);

    // Never set up: past the wait, so the time alone would let it through.
    const neverSetUp = await rpc("evm_snapshot");
    await warp(WAIT + 1);
    check("not set up, past the wait: refused for that (GuardSafeWalletInvalid)", !(await router.checkActiveLegacy(id)) && (await refused(activation(), "GuardSafeWalletInvalid()")));
    await rpc("evm_revert", [neverSetUp]);

    // The app's batch: guard, module, and the guard counts the batch.
    await warp(DAY);
    const ping: Call = { to: guard.address, data: GUARD.encodeFunctionData("checkTransaction", [ZERO, 0, "0x", 0, 0, 0, 0, ZERO, ZERO, "0x", ZERO]) };
    const setUp = await exec(batch([onSafe("setGuard", [guard.address]), onSafe("enableModule", [legacyAddr]), ping]));
    check("the Safe took the guard and the module", (await safe.isModuleEnabled(legacyAddr)) && asAddress(await provider.getStorageAt(safeAddr, GUARD_SLOT)) === guard.address);
    check("the batch counted itself: the wait starts at the set-up", (await clock()) === setUp.at && (await upToDate()));

    await warp(5 * DAY);
    const last = await exec({ to: safeAddr });
    check("a Safe transaction moves the clock", (await clock()) === last.at && (await upToDate()));

    await warp(WAIT - DAY);
    await (await guard.checkTransaction(...txArgs({ to: safeAddr }), signHash(last.hash, strangers()), anyone.address)).wait();
    await (await guard.checkTransaction(...txArgs({ to: safeAddr }), signHash(last.hash, owners.slice(0, 2)), safeAddr)).wait();
    await (await guard.sync()).wait();
    check("a stranger's calls do not: throwaway keys, the owners' last signatures, sync", (await clock()) === last.at);
    check("a day early: refused for that (NotEnoughContitionalActive)", !(await router.checkActiveLegacy(id)) && (await refused(activation(), "NotEnoughContitionalActive()")));

    // The guard taken off and set again while the Safe works on: on a copy of the state.
    const offAndOn = await rpc("evm_snapshot");
    await exec(onSafe("setGuard", [ZERO]));
    await warp(WAIT + 1);
    await exec({ to: safeAddr });
    check("guard off, past the wait: refused for that (GuardSafeWalletInvalid)", !(await router.checkActiveLegacy(id)) && (await refused(activation(), "GuardSafeWalletInvalid()")));
    await exec(onSafe("setGuard", [guard.address]));
    check("guard set again, showing an old time: refused for that (GuardBehindSafeWallet)", !(await router.checkActiveLegacy(id)) && (await refused(activation(), "GuardBehindSafeWallet()")));
    await (await guard.sync()).wait();
    check("anyone has the missed transactions counted, and the wait starts again", (await upToDate()) && (await clock()) === (await now()) && (await refused(activation(), "NotEnoughContitionalActive()")));
    await rpc("evm_revert", [offAndOn]);

    await warp(DAY);
    check("ready after the wait", await router.checkActiveLegacy(id));
    await (await router.connect(anyone).activeLegacy(id)).wait();
    const ownersAfter: string[] = await safe.getOwners();
    check(
      "activated by anyone: both named join the three owners, two needed",
      ownersAfter.length === 5 && heirs.every((h) => ownersAfter.includes(h)) && (await safe.getThreshold()).toNumber() === 2,
    );
    check("activated once (LegacyNotActive), and the check answers false from then on", (await refused(activation(), "LegacyNotActive()")) && !(await router.checkActiveLegacy(id)));
    console.log(`  (Safe ${brief(safeAddr)}, legacy ${brief(legacyAddr)}, guard ${brief(guard.address)}: on the fork only)`);
  }

  // ── The EOA router creates through the new deployer ─────────────────────
  const who = ethers.utils.getAddress(process.env.WALK_SMOKE_AS ?? MAINTAINER);
  console.log(`\nThe EOA router on the new deployer (wave B smoke, as ${who}):`);
  process.env.SMOKE_LIBRARY = "1";
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { runSmokeB } = require("./smoke-train-2026-11-b");
  const train = book.train202611 ?? {};
  const pick = (what: string, ...vals: Array<string | undefined>) => {
    const v = vals.find(Boolean);
    if (!v) throw new Error(`missing address: ${what}`);
    return ethers.utils.getAddress(v);
  };
  const base = (await provider.getBlock("latest")).baseFeePerGas ?? BigNumber.from(0);
  const smokeOk: boolean = await runSmokeB({
    deployer: await as(who),
    addresses: {
      router: eoaRouterAddr,
      v3: pick("TransferEOALegacyV3Impl", train.TransferEOALegacyV3Impl, book.TransferEOALegacyImpl?.address),
      nftList: pick("NftCollectionWhiteList", train.NftCollectionWhiteList, book.NftCollectionWhiteList?.address),
      vault2: pick("LegacyPullVault (v2)", train.LegacyPullVaultV2, book.LegacyPullVault?.address),
      premiumRegistry: pick("PremiumRegistry", book.PremiumRegistry?.address),
      verifier: pick("EIP712LegacyVerifier", book.EIP712LegacyVerifier?.address),
    },
    overrides: { gasPrice: base.mul(2).add(1) },
    fund: ethers.utils.parseEther("1"),
    waitUntil: async (t: number) => {
      if ((await provider.getBlock("latest")).timestamp >= t) return;
      await rpc("evm_setNextBlockTimestamp", [t]);
      await rpc("evm_mine");
    },
    networkName: `${net} fork`,
  });
  check("EOA legacies are created, claimed and ended through the new deployer", smokeOk);

  if (failures.length) {
    console.error(`\nWALK FAILED (${failures.length}):\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nWALK PASSED: nothing was sent to a real network.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
