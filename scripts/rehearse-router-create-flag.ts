/**
 * Walks the router's create-flag change against the legacies that exist on a
 * network, on a local fork: nothing is sent to a real network and no key is
 * needed. It is the check to run BEFORE the new router implementation is
 * deployed and scheduled (rehearse-timelock-op.ts rehearses the scheduled
 * operation itself afterwards).
 *
 * The change: only the claim that ends a legacy releases its owner's create
 * flag, and `releaseCreateFlag` is refused while the pull vault holds a live
 * legacy for the owner. Existing legacies are clones pinned to the code they
 * were created with, so the walk claims on every live one, under the
 * implementation the network runs and under the new one:
 *
 *   1. the first claim after the trigger succeeds, ends the legacy and
 *      releases the flag (both implementations);
 *   2. with the flag set again (what the owner's next create does), a later
 *      claim on the ended legacy clears it under the old implementation and
 *      leaves it under the new one, and that claim still goes through;
 *   3. the owner's `releaseCreateFlag` on the ended legacy still works;
 *   4. the owner's delete of a live legacy still works and releases the
 *      flag, and a second delete reverts.
 * For every ended legacy: a delete by its owner reverts and a release by
 * its owner is accepted (static calls, both implementations).
 *
 * The implementation is swapped as the proxy admin's owner (the timelock,
 * impersonated). Every zero-argument getter of the router is read before
 * and after the swap and must be unchanged.
 *
 * Env (hardhat run forwards no CLI args):
 *   WALK_NETWORK = mainnet | sepolia   (default mainnet)
 *   WALK_SMOKE_AS = address            optional: after the swap, run the
 *                                      wave B smoke (creates, NFT, token and
 *                                      executor legs) as this address, as
 *                                      rehearse-timelock-op.ts does
 *
 * PowerShell:
 *   npx hardhat run scripts/rehearse-router-create-flag.ts
 */
import { BigNumber } from "ethers";
import { ethers, network, artifacts } from "hardhat";
import * as dotenv from "dotenv";
import { getContracts } from "./utils";

dotenv.config();

// ethers v5 at runtime; the installed typings describe v6 (as in the other scripts).
const provider = ethers.provider as any;
const rpc = (method: string, params: unknown[] = []) => network.provider.request({ method, params });
const slotOf = (name: string) => ethers.utils.hexZeroPad(BigNumber.from(ethers.utils.id(name)).sub(1).toHexString(), 32);
const IMPL_SLOT = slotOf("eip1967.proxy.implementation");
const ADMIN_SLOT = slotOf("eip1967.proxy.admin");
const asAddress = (word: string) => ethers.utils.getAddress("0x" + word.slice(26));
const TRUE_WORD = ethers.utils.hexZeroPad("0x01", 32);
const DAY = 86400;

const LEGACY_ABI = [
  "function isLive() view returns (bool)",
  "function getLegacyOwner() view returns (address)",
  "function getLegacyBeneficiaries() view returns (address[], address, address)",
  "function getTriggerActivationTimestamp() view returns (uint256, uint256, uint256)",
];

interface Outcome {
  firstClaim: string;
  flagAfterFirst: boolean | null;
  laterClaim: string;
  flagAfterLater: boolean | null;
  release: string;
  del: string;
  secondDelete: string;
}

async function main() {
  if (network.name !== "hardhat") throw new Error("The walk runs on the in-process hardhat network only (no --network).");
  const net = (process.env.WALK_NETWORK ?? "mainnet").toLowerCase();
  const url = net === "mainnet" ? process.env.MAINNET_RPC_URL : net === "sepolia" ? process.env.SEPOLIA_RPC_URL : undefined;
  if (!url) throw new Error(`Set ${net === "sepolia" ? "SEPOLIA_RPC_URL" : "MAINNET_RPC_URL"} in .env (WALK_NETWORK is mainnet or sepolia).`);
  const book: any = (getContracts() as any)[net];
  const routerAddr: string | undefined = book?.TransferEOALegacyRouter?.address;
  const timelockAddr: string | undefined = book?.UpgradeTimelock?.address;
  if (!routerAddr || !timelockAddr) throw new Error(`No TransferEOALegacyRouter or UpgradeTimelock recorded for ${net}.`);

  await rpc("hardhat_reset", [{ forking: { jsonRpcUrl: url } }]);
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
  const short = (e: any) => {
    const m = String(e?.error?.message ?? e?.reason ?? e?.message ?? e);
    const named = m.match(/custom error '([^']+)'/) ?? m.match(/reverted with reason string '([^']+)'/) ?? m.match(/return data: (0x[0-9a-fA-F]{8})/);
    return `reverts (${named ? named[1] : m.slice(0, 60)})`;
  };

  // ── The router as the network runs it ───────────────────────────────────
  const artifact = await artifacts.readArtifact("TransferEOALegacyRouter");
  const router = new ethers.Contract(routerAddr, artifact.abi, provider);
  const oldImpl = asAddress(await provider.getStorageAt(routerAddr, IMPL_SLOT));
  const proxyAdminAddr = asAddress(await provider.getStorageAt(routerAddr, ADMIN_SLOT));
  const proxyAdmin = new ethers.Contract(
    proxyAdminAddr,
    ["function owner() view returns (address)", "function upgrade(address proxy, address implementation)"],
    provider
  );
  const adminOwner: string = await proxyAdmin.owner();
  console.log(`Router ${routerAddr}, implementation ${oldImpl}, proxy admin ${proxyAdminAddr} owned by ${adminOwner}.`);
  if (adminOwner.toLowerCase() !== timelockAddr.toLowerCase()) throw new Error("The proxy admin's owner is not the recorded UpgradeTimelock.");

  const getters = artifact.abi.filter((f: any) => f.type === "function" && f.inputs.length === 0 && ["view", "pure"].includes(f.stateMutability));
  const readGetters = async () => {
    const out: Record<string, string> = {};
    for (const g of getters) {
      try {
        out[g.name] = String(await router[g.name]());
      } catch {
        out[g.name] = "(reverts)";
      }
    }
    return out;
  };

  // ── Every legacy of the router ──────────────────────────────────────────
  const count: number = (await router._legacyId()).toNumber();
  const legacies: { id: number; address: string; owner: string; live: boolean }[] = [];
  for (let id = 1; id <= count; id++) {
    const address: string = await router.legacyAddresses(id);
    const c = new ethers.Contract(address, LEGACY_ABI, provider);
    legacies.push({ id, address, owner: await c.getLegacyOwner(), live: await c.isLive() });
  }
  const live = legacies.filter((l) => l.live);
  const ended = legacies.filter((l) => !l.live);
  console.log(`${count} legacies: ${live.length} live (${live.map((l) => "#" + l.id).join(", ") || "none"}), ${ended.length} ended.`);

  // The flag's storage slot, found from a live owner's flag and proven by writing it.
  let flagSlot = -1;
  const flagKey = (owner: string, slot: number) => ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [owner, slot]));
  const probe = live.find(Boolean) ?? legacies[0];
  if (probe) {
    const snap = await rpc("evm_snapshot");
    const before: boolean = await router.isCreateLegacy(probe.owner);
    for (let s = 0; s < 40 && flagSlot < 0; s++) {
      const key = flagKey(probe.owner, s);
      const was = await provider.getStorageAt(routerAddr, key);
      await rpc("hardhat_setStorageAt", [routerAddr, key, before ? ethers.constants.HashZero : TRUE_WORD]);
      if ((await router.isCreateLegacy(probe.owner)) !== before) flagSlot = s;
      await rpc("hardhat_setStorageAt", [routerAddr, key, was]);
    }
    await rpc("evm_revert", [snap]);
  }
  if (flagSlot < 0) throw new Error("Could not locate the isCreateLegacy mapping.");
  console.log(`isCreateLegacy is the mapping at storage slot ${flagSlot}.`);
  const setFlag = (owner: string) => rpc("hardhat_setStorageAt", [routerAddr, flagKey(owner, flagSlot), TRUE_WORD]);

  /** The whole life of one live legacy from here, on a snapshot that is thrown away. */
  const walk = async (l: (typeof legacies)[number]): Promise<Outcome> => {
    const out: Outcome = { firstClaim: "", flagAfterFirst: null, laterClaim: "", flagAfterLater: null, release: "", del: "", secondDelete: "" };
    const legacy = new ethers.Contract(l.address, LEGACY_ABI, provider);
    const owner = await as(l.owner);

    // Delete, on its own snapshot.
    let snap = await rpc("evm_snapshot");
    try {
      await (await router.connect(owner).deleteLegacy(l.id)).wait();
      out.del = `ok, live ${await legacy.isLive()}, flag ${await router.isCreateLegacy(l.owner)}`;
      await setFlag(l.owner);
      try {
        await (await router.connect(owner).deleteLegacy(l.id)).wait();
        out.secondDelete = `went through, flag ${await router.isCreateLegacy(l.owner)}`;
      } catch (e) {
        out.secondDelete = `${short(e)}, flag ${await router.isCreateLegacy(l.owner)}`;
      }
    } catch (e) {
      out.del = short(e);
    }
    await rpc("evm_revert", [snap]);

    // Claims.
    snap = await rpc("evm_snapshot");
    try {
      const [first] = await legacy.getLegacyBeneficiaries();
      let at = (await provider.getBlock("latest")).timestamp + 5 * 365 * DAY;
      try {
        const [trigger] = await legacy.getTriggerActivationTimestamp();
        at = Math.max(trigger.toNumber(), (await provider.getBlock("latest")).timestamp) + DAY;
      } catch {
        // an old clone without the getter: five years is past any trigger
      }
      await rpc("evm_setNextBlockTimestamp", [at]);
      await rpc("evm_mine");
      const bene = await as(first[0]);
      try {
        await (await router.connect(bene).activeLegacy(l.id, [], true)).wait();
        out.firstClaim = `ok, live ${await legacy.isLive()}`;
        out.flagAfterFirst = await router.isCreateLegacy(l.owner);
      } catch (e) {
        out.firstClaim = short(e);
      }
      await setFlag(l.owner); // what the owner's next create does
      try {
        await (await router.connect(bene).activeLegacy(l.id, [], true)).wait();
        out.laterClaim = "ok";
      } catch (e) {
        out.laterClaim = short(e);
      }
      out.flagAfterLater = await router.isCreateLegacy(l.owner);
      try {
        await (await router.connect(owner).releaseCreateFlag(l.id)).wait();
        out.release = `ok, flag ${await router.isCreateLegacy(l.owner)}`;
      } catch (e) {
        out.release = short(e);
      }
    } catch (e) {
      out.firstClaim = out.firstClaim || `could not be walked: ${short(e)}`;
    }
    await rpc("evm_revert", [snap]);
    return out;
  };

  /** Static calls by the owner of every ended legacy. */
  const endedDoors = async () => {
    let deleteReverts = 0;
    let releaseOk = 0;
    const odd: string[] = [];
    for (const l of ended) {
      const owner = await as(l.owner);
      try {
        await router.connect(owner).callStatic.deleteLegacy(l.id);
        odd.push(`#${l.id} delete went through`);
      } catch {
        deleteReverts++;
      }
      try {
        await router.connect(owner).callStatic.releaseCreateFlag(l.id);
        releaseOk++;
      } catch (e) {
        odd.push(`#${l.id} release ${short(e)}`);
      }
    }
    return { deleteReverts, releaseOk, odd };
  };

  // ── Under the implementation the network runs ───────────────────────────
  console.log(`\nUnder the implementation the network runs (${oldImpl}):`);
  const before: Record<number, Outcome> = {};
  for (const l of live) before[l.id] = await walk(l);
  const endedBefore = await endedDoors();
  const gettersBefore = await readGetters();
  const flagsBefore: boolean[] = [];
  for (const l of legacies) flagsBefore.push(await router.isCreateLegacy(l.owner));

  // ── The swap ────────────────────────────────────────────────────────────
  const [deployer] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("TransferEOALegacyRouter", deployer);
  const impl = await factory.deploy(timelockAddr);
  const deployRc = await impl.deployTransaction.wait();
  const runtime = (await provider.getCode(impl.address)).length / 2 - 1;
  console.log(`\nNew implementation ${impl.address} on the fork: ${deployRc.gasUsed.toString()} gas, ${runtime} bytes of code.`);
  const upgradeRc = await (await proxyAdmin.connect(await as(adminOwner)).upgrade(routerAddr, impl.address)).wait();
  check(
    "the proxy points at the new implementation",
    asAddress(await provider.getStorageAt(routerAddr, IMPL_SLOT)) === impl.address,
    `${upgradeRc.gasUsed.toString()} gas`
  );

  console.log("\nAfter the swap:");
  const gettersAfter = await readGetters();
  const changed = Object.keys(gettersBefore).filter((k) => gettersBefore[k] !== gettersAfter[k]);
  check(`all ${getters.length} zero-argument getters of the router read the same`, changed.length === 0, changed.join(", "));
  const flagsAfter: boolean[] = [];
  for (const l of legacies) flagsAfter.push(await router.isCreateLegacy(l.owner));
  check(
    "every owner's create flag reads the same",
    flagsBefore.every((f, i) => f === flagsAfter[i])
  );
  for (const l of legacies) {
    if ((await router.legacyAddresses(l.id)) !== l.address) failures.push(`legacy #${l.id} address changed`);
  }
  check("every legacy id resolves to the same address", !failures.some((f) => f.includes("address changed")));

  // ── Under the new implementation ────────────────────────────────────────
  console.log("\nLive legacies, old implementation → new implementation:");
  for (const l of live) {
    const b = before[l.id];
    const a = await walk(l);
    console.log(`  #${l.id} ${l.address}`);
    console.log(`    first claim:   ${b.firstClaim}, flag ${b.flagAfterFirst}  →  ${a.firstClaim}, flag ${a.flagAfterFirst}`);
    console.log(`    later claim:   ${b.laterClaim}, flag ${b.flagAfterLater}  →  ${a.laterClaim}, flag ${a.flagAfterLater}`);
    console.log(`    owner release: ${b.release}  →  ${a.release}`);
    console.log(`    owner delete:  ${b.del}; again ${b.secondDelete}  →  ${a.del}; again ${a.secondDelete}`);
    check(
      `#${l.id}: the first claim goes through, ends the legacy and releases the flag`,
      a.firstClaim === "ok, live false" && a.flagAfterFirst === false
    );
    check(`#${l.id}: a later claim behaves as before and leaves the flag set`, a.laterClaim === b.laterClaim && a.flagAfterLater === true);
    check(`#${l.id}: the owner's release of the ended legacy clears the flag`, a.release === "ok, flag false");
    check(
      `#${l.id}: delete works as before, and a second delete reverts with the flag left set`,
      a.del === b.del && a.del.startsWith("ok") && a.secondDelete.startsWith("reverts") && a.secondDelete.endsWith("flag true")
    );
  }
  const endedAfter = await endedDoors();
  console.log(`\nEnded legacies (${ended.length}), by their owners, static:`);
  console.log(
    `  old: delete reverts on ${endedBefore.deleteReverts}, release accepted on ${endedBefore.releaseOk}${
      endedBefore.odd.length ? `; ${endedBefore.odd.join("; ")}` : ""
    }`
  );
  console.log(
    `  new: delete reverts on ${endedAfter.deleteReverts}, release accepted on ${endedAfter.releaseOk}${
      endedAfter.odd.length ? `; ${endedAfter.odd.join("; ")}` : ""
    }`
  );
  check("a delete of an ended legacy reverts for every one", endedAfter.deleteReverts === ended.length);
  // The one release the new implementation refuses and the old one accepted: the vault holds a live legacy for that owner.
  const refused = endedAfter.odd.filter((o) => o.includes("release"));
  check(
    "a release is refused only while the vault holds a live legacy for that owner",
    refused.every((o) => o.includes("LegacyStillActive")) && endedAfter.releaseOk + refused.length === endedBefore.releaseOk,
    refused.length ? `${refused.length} refused` : "none refused"
  );

  // ── Creates and claims on the upgraded router ───────────────────────────
  if (process.env.WALK_SMOKE_AS) {
    const who = ethers.utils.getAddress(process.env.WALK_SMOKE_AS);
    console.log(`\nWave B smoke on the upgraded router, as ${who}:`);
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
    const ok: boolean = await runSmokeB({
      deployer: await as(who),
      addresses: {
        router: routerAddr,
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
    check("the wave B smoke passes on the upgraded router", ok);
  }

  console.log(
    failures.length === 0 ? "\nWALK PASSED: nothing was sent to a real network." : `\nWALK FAILED (${failures.length}): ${failures.join("; ")}`
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
