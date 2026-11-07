/**
 * Wave B smoke test on Sepolia: the "smoke" of runbook step 4 in
 * docs/plans/train-2026-11.md (wave B). Run AFTER the wave B batch executed:
 *
 *   npx hardhat run scripts/smoke-train-2026-11-b.ts --network sepolia
 *
 * Every transaction carries an explicit gas price (eth_gasPrice x2, or
 * SMOKE_GAS_PRICE_WEI). Signer: the deployer, which must hold OPERATOR on
 * PremiumRegistry (to grant Premium through `subrcribeByAdmin`) and admin on
 * the NFT list (to list the mock collections); a leg that needs a missing
 * role is skipped. Fresh wallets (three owners, a beneficiary, an executor)
 * are funded from the deployer and send what is left back at the end; the
 * other beneficiaries and the backups never send anything and are random
 * addresses. No private key is ever printed.
 *
 * Real time only: backup lines have a 30-day minimum delay, so no backup or
 * second-line claim happens here (the Foundry suites cover those).
 *   1. A legacy through the router (60-second trigger, two first-line
 *      beneficiaries); its clone implementation is v3 and vault2 binds it.
 *   2. NFTs through the vault: a mock ERC-721 and ERC-1155 listed with their
 *      kinds, approved to vault2, named as items (the ERC-721 and 7 of 10
 *      ERC-1155 units, 6 of which the owner sends away first). After the
 *      trigger one claim moves the ERC-721 and the 4 units there, with one
 *      LegacyActivated; the 6 units come back and a second claim moves only
 *      the 3 still owed.
 *   3. Per-share mode on a second legacy (Premium owner): setBackupLines
 *      refused (static) for a repeated first line and for one naming the
 *      second line, then accepted (30-day delay, one backup per primary);
 *      after the trigger primary A claims a token: shareOwner[A] == A, B's
 *      share untouched; a backup's claim reverts BackupNotYet (static).
 *   4. Executor on a third legacy (Premium owner, 240-second trigger):
 *      attestDeath refused before half the trigger, accepted after; the
 *      owner checks in through the router; the deadline is the full trigger
 *      from the check-in, the attestation no longer counts, and the executor
 *      received nothing. (With a trigger short enough to wait out, the
 *      30-day grace cannot shorten the deadline; the Foundry fuzz test
 *      `testFuzz_executorTiming` covers the shortening.)
 *   5. Whole estate as wave A: on legacy 1 (no backup lines) a token claim
 *      pays both beneficiaries their percentages, less the fee.
 *
 * Addresses: contract-addresses.json for the network; the v3 implementation
 * and the NFT list from `train202611` (written by train-2026-11.ts wave b),
 * else top-level `TransferEOALegacyV3Impl` / `NftCollectionWhiteList`.
 * The router must already create v3 clones and vault2 must allow them, or
 * the run stops before sending anything.
 */
import { BigNumber, Contract, Signer, Wallet } from "ethers";
import { ethers, network } from "hardhat";
import { getContracts } from "./utils";

type Status = "PASS" | "FAIL" | "SKIP";

export interface SmokeBAddresses {
  router: string;
  v3: string;
  nftList: string;
  vault2: string;
  premiumRegistry: string;
  verifier: string;
}

export interface SmokeBContext {
  deployer: Signer;
  addresses: SmokeBAddresses;
  overrides: Record<string, unknown>;
  /** ETH given to each funded fresh wallet. */
  fund: BigNumber;
  waitUntil: (ts: number) => Promise<void>;
  networkName: string;
}

const ZERO = ethers.constants.AddressZero;
const MAX = ethers.constants.MaxUint256;
const ERRORS = [
  "FirstLineInvalid()",
  "BackupNotYet(uint256)",
  "AttestationNotAllowed()",
  "NothingClaimed()",
  "ShareOwned(address)",
].map((s) => ({ name: s, selector: ethers.utils.id(s).slice(0, 10) }));

function revertName(err: any): string {
  const blob = (JSON.stringify(err ?? "") + " " + (err?.message ?? "")).toLowerCase();
  for (const { name, selector } of ERRORS) if (blob.includes(selector)) return name;
  const m = blob.match(/reverted with custom error '([a-z0-9_]+)\(/i);
  return m ? `${m[1]}(...)` : `unknown (${String(err?.message ?? err).slice(0, 120)})`;
}

const EIP1167_PREFIX = "0x363d3d373d3d3d363d73";

export async function runSmokeB(ctx: SmokeBContext): Promise<boolean> {
  const { deployer, addresses: a, overrides } = ctx;
  const provider = deployer.provider!;
  const me = await deployer.getAddress();
  const results: Record<string, { status: Status; detail: string }> = {};
  const txs: Record<string, string[]> = {};
  let current = "setup";
  const legs = [
    "1 create through the router, v3 clone",
    "2 NFTs through the vault, partial then remainder",
    "3 per-share mode, share ownership",
    "4 executor attestation cancelled by a check-in",
    "5 whole estate as wave A",
  ];
  const set = (leg: string, status: Status, detail: string) => {
    if (!results[leg]) results[leg] = { status, detail };
  };
  const failed = (leg: string, e: any) => set(leg, "FAIL", e?.reason ?? e?.message ?? String(e));

  const send = async (c: Contract, method: string, args: unknown[], extra: Record<string, unknown> = {}) => {
    const ov = { ...overrides, ...extra };
    const estimate: BigNumber = await c.estimateGas[method](...args, ov);
    const tx = await c[method](...args, { ...ov, gasLimit: estimate.mul(13).div(10) });
    (txs[current] ??= []).push(tx.hash);
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`${method} reverted (${tx.hash})`);
    return rc;
  };
  const deploy = async (name: string, args: unknown[]) => {
    const c = await (await ethers.getContractFactory(name, deployer)).deploy(...args, overrides);
    (txs[current] ??= []).push(c.deployTransaction.hash);
    await c.deployed();
    return c;
  };
  const expectRevert = async (call: () => Promise<unknown>, error: string): Promise<string> => {
    try {
      await call();
    } catch (e: any) {
      const got = revertName(e);
      return got === error ? "" : `expected ${error}, got ${got}`;
    }
    return `expected ${error}, the call succeeded`;
  };
  const now = async () => (await provider.getBlock("latest")).timestamp;
  const logsOf = (rc: any, c: Contract, name: string) =>
    rc.logs
      .filter((l: any) => l.address.toLowerCase() === c.address.toLowerCase())
      .map((l: any) => {
        try {
          return c.interface.parseLog(l);
        } catch {
          return undefined;
        }
      })
      .filter((p: any) => p && p.name === name);

  const balanceBefore = await provider.getBalance(me);
  console.log(`Network ${ctx.networkName}, deployer ${me}, balance ${ethers.utils.formatEther(balanceBefore)} ETH`);
  console.log(`Gas price ${JSON.stringify(overrides)}; ${ethers.utils.formatEther(ctx.fund)} ETH per funded wallet`);

  // ── Gate: the wave B batch executed ─────────────────────────────────────
  const router = await ethers.getContractAt("TransferEOALegacyRouter", a.router, deployer);
  const vault2 = await ethers.getContractAt("LegacyPullVaultV2", a.vault2, deployer);
  const v3impl = await ethers.getContractAt("TransferEOALegacyV3", a.v3, deployer);
  const liveImpl: string = await router.legacyImplementation();
  const liveVault: string = await router.pullVault();
  const allowed: boolean = await vault2.isAllowedCodehash(await vault2.codehashOf(a.v3));
  const implList: string = await v3impl.nftAllowlist();
  if (liveImpl.toLowerCase() !== a.v3.toLowerCase() || liveVault.toLowerCase() !== a.vault2.toLowerCase() || !allowed) {
    console.log(`The router creates ${liveImpl} through vault ${liveVault}; v3 ${a.v3} allowed by vault2: ${allowed}.`);
    console.log("Has the wave B batch executed? Nothing sent.");
    return false;
  }
  if (implList.toLowerCase() !== a.nftList.toLowerCase()) {
    console.log(`v3's nftAllowlist() is ${implList}, not the recorded list ${a.nftList}. Nothing sent.`);
    return false;
  }

  const runPrice = BigNumber.from((overrides.gasPrice as any) ?? (await provider.getGasPrice()));
  // About 9M gas from the deployer (four mock deployments and setup) plus the five wallets' float.
  const budget = runPrice.mul(12_000_000).add(ctx.fund.mul(5));
  if (balanceBefore.lt(budget)) {
    console.log(`The run needs about ${ethers.utils.formatEther(budget)} ETH at this gas price; the deployer has less. Nothing sent.`);
    return false;
  }

  const registry = await ethers.getContractAt("PremiumRegistry", a.premiumRegistry, deployer);
  const list = await ethers.getContractAt("NftCollectionWhiteList", a.nftList, deployer);
  const verifier = await ethers.getContractAt("EIP712LegacyVerifier", a.verifier, deployer);
  const payment = await ethers.getContractAt("Payment", await router.paymentContract(), deployer);
  const feeBps: BigNumber = await payment.getFee();

  // Premium through the admin subscribe path: OPERATOR and a plan with a duration.
  let premiumPlan = -1;
  let premiumSkip = "";
  if (!(await registry.hasRole(await registry.OPERATOR(), me))) {
    premiumSkip = `the deployer does not hold OPERATOR on PremiumRegistry ${a.premiumRegistry}`;
  } else {
    const count = (await registry.getNextPlanId()).toNumber();
    for (let i = 0; i < count && premiumPlan < 0; i++) {
      const p = await registry.premiumPlans(i);
      if (p.isActive && p.duration.gt(0)) premiumPlan = i;
    }
    if (premiumPlan < 0) premiumSkip = "no active plan with a duration to grant Premium";
  }
  const listAdmin: boolean = await list.hasRole(await list.DEFAULT_ADMIN_ROLE(), me);

  // ── Wallets ─────────────────────────────────────────────────────────────
  const owner1 = Wallet.createRandom().connect(provider);
  const owner2 = Wallet.createRandom().connect(provider);
  const owner3 = Wallet.createRandom().connect(provider);
  const beneA = Wallet.createRandom().connect(provider);
  const exe = Wallet.createRandom().connect(provider);
  const funded = [owner1, owner2, owner3, beneA, exe];
  const beneB = Wallet.createRandom().address;
  const beneC = Wallet.createRandom().address;
  const backupA = Wallet.createRandom().address;
  const backupB = Wallet.createRandom().address;
  console.log(`Owners ${owner1.address} ${owner2.address} ${owner3.address}; beneficiary A ${beneA.address}, B ${beneB}; executor ${exe.address}`);
  for (const w of funded) {
    // A transfer that creates an account costs more than 21,000 gas under the current schedule.
    const tx = await deployer.sendTransaction({ to: w.address, value: ctx.fund, ...overrides });
    (txs.setup ??= []).push(tx.hash);
    await tx.wait();
  }
  const token = await deploy("ERC20Token", ["Smoke B", "SMB", 18]);
  const unit = ethers.utils.parseEther("1000");
  await send(token, "mint", [owner1.address, unit]);
  await send(token, "mint", [owner2.address, unit]);

  const zero = { user: ZERO, percent: 0 };
  const bundle = { permitBatch: { details: [], spender: ZERO, sigDeadline: 0 }, signature: "0x" };
  const create = async (owner: Wallet, dists: any[], trigger: number, layer2: string, delay2: number) => {
    const ts = await now();
    const sig = await owner.signMessage(await verifier.generateVersionedMessage(ts));
    const rc = await send(router.connect(owner), "createLegacyV2WithMaxFee", [
      dists,
      { lackOfOutgoingTxRange: trigger, delayLayer2: delay2, delayLayer3: 0 },
      layer2 === ZERO ? zero : { user: layer2, percent: 1_000_000 },
      zero,
      bundle,
      ts,
      sig,
      feeBps,
    ]);
    const ev = logsOf(rc, router, "TransferEOALegacyCreatedV2")[0];
    return { id: ev.args.legacyId as BigNumber, legacy: await ethers.getContractAt("TransferEOALegacyV3", ev.args.legacyAddress, deployer) };
  };
  const deadlineOf = async (legacy: Contract) => ((await legacy.getTriggerActivationTimestamp())[0] as BigNumber).toNumber();
  const sixtyForty = [
    { user: beneA.address, percent: 600_000 },
    { user: beneB, percent: 400_000 },
  ];

  // ── Leg 1: a v3 legacy ──────────────────────────────────────────────────
  let l1: { id: BigNumber; legacy: Contract } | undefined;
  current = legs[0];
  try {
    l1 = await create(owner1, sixtyForty, 60, ZERO, 0);
    const code = (await provider.getCode(l1.legacy.address)).toLowerCase();
    const impl = code.startsWith(EIP1167_PREFIX) && code.length === 92 ? ethers.utils.getAddress("0x" + code.slice(22, 62)) : "";
    const bound: string = await vault2.boundLegacy(owner1.address);
    const problems: string[] = [];
    if (impl.toLowerCase() !== a.v3.toLowerCase()) problems.push(`clone of ${impl || "unknown code"}, not v3`);
    if (bound.toLowerCase() !== l1.legacy.address.toLowerCase()) problems.push(`vault2 binds ${bound}`);
    if (problems.length) set(current, "FAIL", problems.join("; "));
    else console.log(`      legacy 1 (#${l1.id.toString()}) at ${l1.legacy.address}: an EIP-1167 clone of v3, bound in vault2`);
  } catch (e) {
    failed(current, e);
  }

  // ── Leg 2 setup: collections, items, approvals ──────────────────────────
  let nft721: Contract | undefined;
  let nft1155: Contract | undefined;
  current = legs[1];
  try {
    if (!l1) throw new Error("no legacy 1");
    if (!listAdmin) {
      set(current, "SKIP", `the deployer is not admin of the NFT list ${a.nftList}`);
    } else {
      const c721 = await deploy("MockERC721", []);
      const c1155 = await deploy("MockERC1155", []);
      await send(list, "addCollection", [c721.address]);
      await send(list, "addCollection", [c1155.address]);
      if ((await list.kindOf(c721.address)) !== 1 || (await list.kindOf(c1155.address)) !== 2) throw new Error("the list recorded the wrong kinds");
      await send(c721, "mint", [owner1.address, 1]); // id 0
      await send(c1155, "mint", [owner1.address, 10]); // id 0 x10
      await send(c721.connect(owner1), "setApprovalForAll", [a.vault2, true]);
      await send(c1155.connect(owner1), "setApprovalForAll", [a.vault2, true]);
      await send(l1.legacy.connect(owner1), "setNftItems", [
        [
          { collection: c721.address, kind: 1, tokenId: 0, amount: 1, beneficiary: beneA.address },
          { collection: c1155.address, kind: 2, tokenId: 0, amount: 7, beneficiary: beneB },
        ],
      ]);
      // 6 of the 10 units leave the owner's wallet before the claim.
      await send(c1155.connect(owner1), "safeTransferFrom", [owner1.address, me, 0, 6, "0x"]);
      [nft721, nft1155] = [c721, c1155];
    }
    // Leg 5's token, approved directly to legacy 1.
    await send(token.connect(owner1), "approve", [l1.legacy.address, MAX]);
  } catch (e) {
    failed(current, e);
  }

  // ── Leg 3 setup: Premium, refusals, backup lines ────────────────────────
  let l2: { id: BigNumber; legacy: Contract } | undefined;
  current = legs[2];
  try {
    if (premiumSkip) {
      set(current, "SKIP", premiumSkip);
    } else {
      await send(registry, "subrcribeByAdmin", [owner2.address, premiumPlan, "smoke"]);
      // Created with a repeated first-line address (the wave A initializer accepts it) and a second line.
      l2 = await create(
        owner2,
        [
          { user: beneA.address, percent: 300_000 },
          { user: beneB, percent: 400_000 },
          { user: beneA.address, percent: 300_000 },
        ],
        60,
        beneC,
        60 * 86400
      );
      const lineA = [{ primary: beneA.address, second: backupA, third: ZERO }];
      const problems: string[] = [];
      let why = await expectRevert(() => l2!.legacy.connect(owner2).callStatic.setBackupLines(30 * 86400, lineA), "FirstLineInvalid()");
      if (why) problems.push(`repeated first line: ${why}`);
      // Whole-estate mode accepts a first line naming the second line, as wave A does...
      await send(router.connect(owner2), "setLegacyDistributions", [l2.id, ["", ""], [{ user: beneA.address, percent: 500_000 }, { user: beneC, percent: 500_000 }]]);
      // ...and per-share mode refuses it.
      why = await expectRevert(() => l2!.legacy.connect(owner2).callStatic.setBackupLines(30 * 86400, lineA), "FirstLineInvalid()");
      if (why) problems.push(`first line naming the second line: ${why}`);
      await send(router.connect(owner2), "setLegacyDistributions", [l2.id, ["", ""], sixtyForty]);
      await send(l2.legacy.connect(owner2), "setBackupLines", [
        30 * 86400,
        [
          { primary: beneA.address, second: backupA, third: ZERO },
          { primary: beneB, second: backupB, third: ZERO },
        ],
      ]);
      await send(token.connect(owner2), "approve", [l2.legacy.address, MAX]);
      if (problems.length) set(current, "FAIL", problems.join("; "));
      else console.log(`      legacy 2 (#${l2.id.toString()}): both stranding first lines refused, per-share mode on (30-day backups)`);
    }
  } catch (e) {
    failed(current, e);
  }

  // ── Leg 4: executor, in full (its waits cover the 60-second triggers) ───
  current = legs[3];
  try {
    if (premiumSkip) {
      set(current, "SKIP", premiumSkip);
    } else {
      await send(registry, "subrcribeByAdmin", [owner3.address, premiumPlan, "smoke"]);
      const l3 = await create(owner3, [{ user: beneA.address, percent: 1_000_000 }], 240, ZERO, 0);
      await send(l3.legacy.connect(owner3), "setExecutor", [exe.address]);
      const problems: string[] = [];
      let why = await expectRevert(() => l3.legacy.connect(exe).callStatic.attestDeath(), "AttestationNotAllowed()");
      if (why) problems.push(`attestation before half the trigger: ${why}`);
      const last = (await l3.legacy.getLastTimestamp()).toNumber();
      console.log(`      legacy 3 (#${l3.id.toString()}): waiting for half of the 240-second trigger`);
      await ctx.waitUntil(last + 122);
      const exeEth = await provider.getBalance(exe.address);
      const rc = await send(l3.legacy.connect(exe), "attestDeath", []);
      const attestGas = rc.gasUsed.mul(rc.effectiveGasPrice ?? runPrice);
      const attestedAt = (await l3.legacy.deathAttestedAt()).toNumber();
      if (attestedAt !== (await provider.getBlock(rc.blockNumber)).timestamp) problems.push("deathAttestedAt is not the attestation block");
      if ((await deadlineOf(l3.legacy)) !== last + 240) problems.push("the attestation moved the deadline (the 30-day grace cannot shorten a 240-second trigger)");
      const rc2 = await send(router.connect(owner3), "avtiveAlive", [l3.id]);
      const checkIn = (await provider.getBlock(rc2.blockNumber)).timestamp;
      if ((await l3.legacy.getLastTimestamp()).toNumber() !== checkIn) problems.push("the check-in did not record activity");
      if ((await deadlineOf(l3.legacy)) !== checkIn + 240) problems.push("the deadline is not the full trigger from the check-in");
      if ((await l3.legacy.deathAttestedAt()).toNumber() >= checkIn) problems.push("the attestation still counts after the check-in");
      why = await expectRevert(() => l3.legacy.connect(exe).callStatic.attestDeath(), "AttestationNotAllowed()");
      if (why) problems.push(`attestation right after the check-in: ${why}`);
      const exeAfter = await provider.getBalance(exe.address);
      if (!exeAfter.eq(exeEth.sub(attestGas))) problems.push(`executor ETH ${exeAfter.toString()}, expected ${exeEth.sub(attestGas).toString()}`);
      if (!(await token.balanceOf(exe.address)).isZero()) problems.push("the executor holds tokens");
      set(
        current,
        problems.length ? "FAIL" : "PASS",
        problems.length ? problems.join("; ") : "refused before half the trigger, accepted after; the check-in restored the full trigger and voided the attestation; the executor received nothing"
      );
    }
  } catch (e) {
    failed(current, e);
  }

  // ── Claims after the 60-second triggers ─────────────────────────────────
  const waitFor = async (legacy: Contract) => ctx.waitUntil((await deadlineOf(legacy)) + 2);

  current = legs[1];
  try {
    if (!results[current]) {
      if (!l1 || !nft721 || !nft1155) throw new Error("setup incomplete");
      const [n721, n1155]: [Contract, Contract] = [nft721, nft1155];
      await waitFor(l1.legacy);
      const problems: string[] = [];
      const rc = await send(l1.legacy.connect(beneA), "claimNfts", [[0, 1]]);
      const activated = logsOf(rc, l1.legacy, "LegacyActivated").length;
      if ((await n721.ownerOf(0)) !== beneA.address) problems.push("the ERC-721 did not reach A");
      if (!(await n1155.balanceOf(beneB, 0)).eq(4)) problems.push(`B holds ${(await n1155.balanceOf(beneB, 0)).toString()} ERC-1155 units after the first claim, expected 4`);
      if (activated !== 1) problems.push(`${activated} LegacyActivated events in the first claim`);
      await send(n1155, "safeTransferFrom", [me, owner1.address, 0, 6, "0x"]); // the units come back
      const rc2 = await send(l1.legacy.connect(beneA), "claimNfts", [[1]]);
      if (!(await n1155.balanceOf(beneB, 0)).eq(7)) problems.push(`B holds ${(await n1155.balanceOf(beneB, 0)).toString()} units after the second claim, expected 7`);
      if (!(await n1155.balanceOf(owner1.address, 0)).eq(3)) problems.push("the owner should keep the 3 units the item does not name");
      const [, moved] = await l1.legacy.nftItem(1);
      if (!moved.eq(7)) problems.push(`item moved ${moved.toString()} of 7`);
      if (logsOf(rc2, l1.legacy, "LegacyActivated").length !== 0) problems.push("the second claim emitted LegacyActivated again");
      set(
        current,
        problems.length ? "FAIL" : "PASS",
        problems.length ? problems.join("; ") : "ERC-721 and 4 units through vault2 with one LegacyActivated; after the units came back, only the 3 owed moved"
      );
    }
  } catch (e) {
    failed(current, e);
  }

  current = legs[2];
  try {
    if (!results[current]) {
      if (!l2) throw new Error("no legacy 2");
      await waitFor(l2.legacy);
      const problems: string[] = [];
      await send(router.connect(beneA), "activeLegacy", [l2.id, [token.address], false]);
      const sixty = unit.mul(600_000).div(1_000_000);
      if ((await l2.legacy.shareOwner(beneA.address)) !== beneA.address) problems.push("shareOwner[A] is not A");
      if (!(await l2.legacy.released(token.address, beneA.address)).eq(sixty)) problems.push("A's share did not release 60%");
      if (!(await l2.legacy.released(token.address, beneB)).isZero() || (await l2.legacy.shareOwner(beneB)) !== ZERO) problems.push("B's share was touched");
      if (!(await token.balanceOf(beneB)).isZero()) problems.push("B received tokens from A's claim");
      if (!(await token.balanceOf(owner2.address)).eq(unit.sub(sixty))) problems.push("the owner's wallet does not hold B's 40%");
      const why = await expectRevert(
        () => router.connect(provider).callStatic.activeLegacy(l2!.id, [token.address], false, { from: backupA }),
        "BackupNotYet(uint256)"
      );
      if (why) problems.push(`backup claim: ${why}`);
      set(current, problems.length ? "FAIL" : "PASS", problems.length ? problems.join("; ") : "A claimed and owns A's share; B's share untouched; A's backup refused (BackupNotYet)");
    }
  } catch (e) {
    failed(current, e);
  }

  current = legs[4];
  try {
    if (!l1) throw new Error("no legacy 1");
    await waitFor(l1.legacy);
    const aBefore: BigNumber = await token.balanceOf(beneA.address);
    const bBefore: BigNumber = await token.balanceOf(beneB);
    await send(router.connect(beneA), "activeLegacy", [l1.id, [token.address], false]);
    const distributable = unit.sub(unit.mul(feeBps).div(10_000));
    const wantA = distributable.mul(600_000).div(1_000_000);
    const wantB = distributable.sub(wantA);
    const gotA = (await token.balanceOf(beneA.address)).sub(aBefore);
    const gotB = (await token.balanceOf(beneB)).sub(bBefore);
    const ok = gotA.eq(wantA) && gotB.eq(wantB) && (await l1.legacy.backupDelay()).eq(0);
    set(current, ok ? "PASS" : "FAIL", `A received ${gotA.toString()} (expected ${wantA.toString()}), B ${gotB.toString()} (expected ${wantB.toString()}), fee ${feeBps.toString()} bps`);
  } catch (e) {
    failed(current, e);
  }
  set(legs[0], "PASS", "an EIP-1167 clone of the recorded v3, bound in vault2");

  // ── Sweep and report ────────────────────────────────────────────────────
  for (const w of funded) {
    const bal = await provider.getBalance(w.address);
    const cost = runPrice.mul(21000);
    if (bal.gt(cost)) {
      try {
        await (await w.sendTransaction({ to: me, value: bal.sub(cost), gasLimit: 21000, gasPrice: runPrice })).wait();
      } catch (e: any) {
        console.log(`      sweep from ${w.address} failed: ${e?.message ?? e}`);
      }
    }
  }
  for (const leg of legs) {
    const r = results[leg] ?? { status: "FAIL" as Status, detail: "no result" };
    const hashes = txs[leg]?.length ? `\n      tx ${txs[leg].join("\n      tx ")}` : "";
    console.log(`${r.status.padEnd(4)}  ${leg}: ${r.detail}${hashes}`);
  }
  const balanceAfter = await provider.getBalance(me);
  const left = (await Promise.all(funded.map((w) => provider.getBalance(w.address)))).reduce((s, b) => s.add(b), BigNumber.from(0));
  console.log(
    `\nSpent ${ethers.utils.formatEther(balanceBefore.sub(balanceAfter))} ETH from the deployer (balance ${ethers.utils.formatEther(balanceAfter)}); ${ethers.utils.formatEther(left)} ETH left in the fresh wallets.`
  );
  const all = legs.map((l) => results[l]?.status ?? "FAIL");
  const fails = all.filter((s) => s === "FAIL").length;
  console.log(`${all.filter((s) => s === "PASS").length} PASS, ${fails} FAIL, ${all.filter((s) => s === "SKIP").length} SKIP`);
  return fails === 0;
}

async function main() {
  if (network.name === "mainnet") throw new Error("This smoke test sends transactions: Sepolia (or a local chain) only.");
  const net: any = (getContracts() as any)[network.name];
  if (!net) throw new Error(`No addresses for ${network.name} in contract-addresses.json`);
  const pick = (what: string, ...vals: Array<string | undefined>) => {
    const v = vals.find(Boolean);
    if (!v) throw new Error(`missing address: ${what}`);
    return ethers.utils.getAddress(v);
  };
  const train = net.train202611 ?? {};
  const addresses: SmokeBAddresses = {
    router: pick("TransferEOALegacyRouter", net.TransferEOALegacyRouter?.address),
    v3: pick("train202611.TransferEOALegacyV3Impl", train.TransferEOALegacyV3Impl, net.TransferEOALegacyV3Impl?.address),
    nftList: pick("train202611.NftCollectionWhiteList", train.NftCollectionWhiteList, net.NftCollectionWhiteList?.address),
    vault2: pick("LegacyPullVault (v2)", train.LegacyPullVaultV2, net.LegacyPullVault?.address),
    premiumRegistry: pick("PremiumRegistry", net.PremiumRegistry?.address),
    verifier: pick("EIP712LegacyVerifier", net.EIP712LegacyVerifier?.address),
  };
  const [first] = await ethers.getSigners();
  if (!first) throw new Error(`No signer for ${network.name}: DEPLOYER_PRIVATE_KEY is not configured.`);
  const deployer = first as unknown as Signer; // ethers v5 at runtime

  const rpcPrice = BigNumber.from(await ethers.provider.send("eth_gasPrice", []));
  const base = (await ethers.provider.getBlock("latest")).baseFeePerGas ?? BigNumber.from(0);
  const gasPrice = process.env.SMOKE_GAS_PRICE_WEI
    ? BigNumber.from(process.env.SMOKE_GAS_PRICE_WEI)
    : (rpcPrice.gt(base) ? rpcPrice : base).mul(2).add(1);
  // Enough for the busiest wallet (the per-share owner, about 1.5M gas) twice over.
  const floor = gasPrice.mul(3_000_000);
  const asked = ethers.utils.parseEther(process.env.SMOKE_FUND_ETH ?? "0.00005");
  const fund = asked.gt(floor) ? asked : floor;
  const waitUntil = async (ts: number) => {
    for (;;) {
      const latest = (await ethers.provider.getBlock("latest")).timestamp;
      if (latest >= ts) return;
      await new Promise((r) => setTimeout(r, Math.min(15_000, (ts - latest) * 1000 + 3000)));
    }
  };

  const ok = await runSmokeB({ deployer, addresses, overrides: { gasPrice }, fund, waitUntil, networkName: network.name });
  if (!ok) process.exitCode = 1;
}

if (!process.env.SMOKE_LIBRARY) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
