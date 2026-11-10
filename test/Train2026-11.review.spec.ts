import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// Findings of the two cross-model reviews of the round 10 code
// (docs/security/wave-b-audit-scope.md): the direct rail with a token that
// moves funds and returns false, the router guard with a caller-dependent
// storage token (K-14), the whole-estate fee order, and the untested cases
// both reviews listed. Every spec runs on the clone code that would be
// deployed (the base at HEAD and v3); the known issue of deployed clones is
// shown on the live mainnet clone code.

const MAX = ethers.constants.MaxUint256;
const MAX160 = ethers.BigNumber.from(2).pow(160).sub(1);
const ZERO = ethers.constants.AddressZero;
const T = 1_000_000_000;
const BURN_ALL_GAS = "0x5b600056"; // JUMPDEST PUSH1 0 JUMP: loops until out of gas
const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "live", "mainnet-implementations.json"), "utf-8"));

const v3Options = { implName: "TransferEOALegacyV3", implArgs: (c: any) => [c.nftAllowlist], withNftAllowlist: true };
const waveA = () => deployTrain();
const v3 = () => deployTrain(v3Options);
const feeOf = (amount: number) => Math.floor((amount * 25) / 10_000);
const sixtyForty = (f: any) => [
  { user: f.bene.address, percent: 600000 },
  { user: f.bene2.address, percent: 400000 },
];
const sixty = (net: number) => Math.floor((net * 6) / 10);

async function weird(f: any, amount = T) {
  const w = await (await ethers.getContractFactory("MockWeirdERC20")).deploy();
  if (amount > 0) await w.mint(f.owner.address, amount);
  return w;
}

async function awkward(f: any) {
  const a = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
  await a.mint(f.owner.address, T);
  return a;
}

async function perShare(f: any, distributions = sixtyForty(f)) {
  const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, distributions, { contractName: "TransferEOALegacyV3" });
  await legacy.connect(f.owner).setBackupLines(30 * DAY, [{ primary: distributions[0].user, second: f.bene3.address, third: ZERO }]);
  return { legacy, legacyId };
}

async function bal(token: any, who: any) {
  return (await token.balanceOf(who.address ?? who)).toNumber();
}

describe("Train 2026-11 — review findings on the round 10 code", function () {
  this.timeout(300000);

  describe("direct rail: a token that moves funds and returns false (review Medium)", function () {
    for (const [label, fixture, contractName] of [
      ["base clone at HEAD", waveA, "TransferEOALegacy"],
      ["v3, whole estate", v3, "TransferEOALegacyV3"],
    ] as const) {
      for (const moveBps of [10_000, 4_000]) {
        it(`${label}: a ${moveBps === 10_000 ? "full" : "partial"} move that returns false is rolled back; later claims split exactly`, async function () {
          const f = await loadFixture(fixture);
          const w = await weird(f);
          const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, sixtyForty(f), { contractName });
          await w.connect(f.owner).approve(legacy.address, MAX);
          await w.setLie(true, moveBps, 0);
          await increase(DAY + 1);
          await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false);
          await f.router.connect(f.bene2).activeLegacy(legacyId, [w.address], false);
          assert.equal(await bal(w, f.owner), T, "nothing left the owner's wallet");
          assert.equal((await bal(w, f.bene)) + (await bal(w, f.bene2)) + (await bal(w, f.payment)), 0);

          await w.setLie(false, 0, 0);
          await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false);
          const net = T - feeOf(T);
          assert.equal(await bal(w, f.bene), sixty(net));
          assert.equal(await bal(w, f.bene2), net - sixty(net));
          assert.equal(await bal(w, f.payment), feeOf(T));
          assert.equal(await bal(w, f.owner), 0);
        });
      }
    }

    for (const moveBps of [10_000, 4_000]) {
      it(`v3 per-share: repeated claims with a ${moveBps === 10_000 ? "full" : "partial"} false-returning move take nothing from B's share`, async function () {
        const f = await loadFixture(v3);
        const w = await weird(f);
        const { legacy, legacyId } = await perShare(f);
        await w.connect(f.owner).approve(legacy.address, MAX);
        await w.setLie(true, moveBps, 0);
        await increase(DAY + 1);
        for (let i = 0; i < 3; i++) await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false);
        assert.equal(await bal(w, f.bene), 0, "A received nothing");
        assert.equal(await bal(w, f.owner), T, "nothing moved");
        assert.equal((await legacy.released(w.address, f.bene.address)).toString(), "0");
        assert.equal(await legacy.shareOwner(f.bene.address), ZERO, "an unpaid share has no owner");

        await w.setLie(false, 0, 0);
        await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false);
        await f.router.connect(f.bene2).activeLegacy(legacyId, [w.address], false);
        assert.equal(await bal(w, f.bene), 600_000_000 - feeOf(600_000_000));
        assert.equal(await bal(w, f.bene2), 400_000_000 - feeOf(400_000_000), "B's share is whole");
        assert.equal(await bal(w, f.owner), 0);
      });
    }

    // Deployed clones run the live code below. The wave A clone (mainnet
    // 0x2E2d…924C, the target of new creates since 2026-11-07) counts such a
    // move as failed; older versions ignore the return value.
    async function onLiveCode(key: string, feeBps: number) {
      const f = await deployTrain({ feeBps });
      const liveClone = ethers.Wallet.createRandom().address;
      await ethers.provider.send("hardhat_setCode", [liveClone, LIVE.implementations[key].code]);
      await f.router.connect(f.timelock).setPullVault(ZERO);
      await f.router.connect(f.timelock).setLegacyImplementation(liveClone);
      const w = await weird(f);
      const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, sixtyForty(f));
      await w.connect(f.owner).approve(legacy.address, MAX);
      await w.setLie(true, 10_000, 0);
      await increase(DAY + 1);
      return { f, w, legacy, legacyId };
    }

    it("known issue, deployed wave A clone with a zero fee: the move counts as failed and the last-listed heir is starved", async function () {
      const { f, w, legacyId } = await onLiveCode("TransferEOALegacyWaveA", 0);
      await f.router.connect(f.bene2).activeLegacy(legacyId, [w.address], false);
      // A's 600 moved but counted as failed, so B was asked for all 1,000.
      assert.equal(await bal(w, f.bene), 600_000_000);
      assert.equal(await bal(w, f.bene2), 0);
      await f.router.connect(f.bene2).activeLegacy(legacyId, [w.address], false);
      assert.equal(await bal(w, f.bene), 840_000_000, "A takes 60% of what is left again");
      assert.equal(await bal(w, f.bene2), 0, "B gets nothing, claim after claim");
    });

    it("known issue, deployed wave A clone with the 25 bps fee new creates get: a claim listing such a token reverts, other tokens still claim", async function () {
      const { f, w, legacy, legacyId } = await onLiveCode("TransferEOALegacyWaveA", 25);
      await f.usdc.connect(f.owner).approve(legacy.address, MAX);
      // The fee moves into the legacy, then the swap and its fallback
      // transfer to Payment both see `false` and revert.
      await expectRevert(f.router.connect(f.bene).activeLegacy(legacyId, [w.address, f.usdc.address], false), "SafeERC20FailedOperation(address)");
      assert.equal(await bal(w, f.owner), T, "nothing moved");
      await f.router.connect(f.bene).activeLegacy(legacyId, [f.usdc.address], false);
      assert((await bal(f.usdc, f.bene)) > 0);
    });

    it("older clone versions (the live 2026-07-30 code) ignore the return value, so such a move is counted as paid: no bias", async function () {
      const { f, w, legacyId } = await onLiveCode("TransferEOALegacyClone", 0);
      await f.router.connect(f.bene2).activeLegacy(legacyId, [w.address], false);
      assert.equal(await bal(w, f.bene), 600_000_000);
      assert.equal(await bal(w, f.bene2), 400_000_000);
      assert.equal(await bal(w, f.owner), 0);
    });
  });

  describe("router guard and a storage token that answers callers differently (K-14, accepted)", function () {
    async function hostileStorage(f: any) {
      const w = await weird(f, 0);
      await w.mint(f.uni.address, 10 * T);
      const halves = [
        { user: f.bene.address, percent: 500000 },
        { user: f.bene2.address, percent: 500000 },
      ];
      const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, halves);
      const now = await currentTime();
      await f.router.connect(f.owner).autoSwap(legacyId, { storageToken: w.address, amountOutMin: 1, deadline: now + 3600 }, { value: T });
      await w.connect(f.owner).approve(legacy.address, MAX);
      await w.setHiddenFrom(f.router.address);
      await increase(DAY + 1);
      return { w, legacy, legacyId, deadline: now + 3600 + DAY };
    }

    it("a token that reports 0 to the router passes the guard; a live old clone then swaps at the caller's zero minimum", async function () {
      const f = await deployTrain();
      const liveClone = ethers.Wallet.createRandom().address;
      await ethers.provider.send("hardhat_setCode", [liveClone, LIVE.implementations.TransferEOALegacyClone.code]);
      await f.router.connect(f.timelock).setPullVault(ZERO);
      await f.router.connect(f.timelock).setLegacyImplementation(liveClone);
      const { w, legacyId, deadline } = await hostileStorage(f);
      const uniTokens = await bal(w, f.uni);
      const before = await ethers.provider.getBalance(f.bene2.address);
      await f.router.connect(f.bene).activeLegacyAndUnswap(legacyId, [], 0, deadline);
      assert.equal((await bal(w, f.uni)) - uniTokens, T, "the old clone swapped everything at a zero minimum");
      assert((await ethers.provider.getBalance(f.bene2.address)).gt(before), "the co-beneficiary got their half in ETH");
    });

    it("the same token on a HEAD clone: the clone reads its own balance and allowance and keeps both guards", async function () {
      const f = await loadFixture(waveA);
      const { legacyId, deadline } = await hostileStorage(f);
      await expectRevert(f.router.connect(f.bene).activeLegacyAndUnswap(legacyId, [], 0, deadline), "ZeroAmountOutMin()");
      await expectRevert(f.router.connect(f.bene).activeLegacyAndUnswap(legacyId, [], 1, deadline), "UnswapNeedsSoleRecipient()");
    });
  });

  describe("whole-estate fee order (review L-1)", function () {
    for (const [label, fixture, contractName] of [
      ["base clone at HEAD", waveA, "TransferEOALegacy"],
      ["v3, whole estate", v3, "TransferEOALegacyV3"],
    ] as const) {
      it(`${label}: the fee is pulled after the heirs, so a token that takes more than the amount under a finite allowance pays every heir`, async function () {
        const f = await loadFixture(fixture);
        const w = await weird(f);
        const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, sixtyForty(f), { contractName });
        await w.connect(f.owner).approve(legacy.address, T);
        await w.setSurcharge(10); // takes 0.1% more than each amount
        await increase(DAY + 1);
        await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false);
        const net = T - feeOf(T);
        assert.equal(await bal(w, f.bene), sixty(net));
        assert.equal(await bal(w, f.bene2), net - sixty(net), "the last heir is paid in full");
        // 998,497,500 left the wallet for the heirs; the fee (with its
        // surcharge) no longer fits the allowance and is not collected.
        assert.equal(await bal(w, f.payment), 0);
        assert.equal(await bal(w, f.owner), T - (sixty(net) + (net - sixty(net))) - Math.floor((sixty(net) * 10) / 10_000) - Math.floor(((net - sixty(net)) * 10) / 10_000));
      });
    }
  });

  describe("cases both reviews listed as untested", function () {
    for (const rail of ["vault", "permit2"] as const) {
      it(`unswap claim with a ${rail} approval and a small direct allowance: the direct part is swapped, the rest paid on its rail, in one call`, async function () {
        const f = await loadFixture(waveA);
        const { owner, bene, router, usdc, uni, payment, permit2, vault } = f;
        await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
        const { legacy, legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
        const now = await currentTime();
        await router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 1, deadline: now + 3600 }, { value: T });
        assert.equal(await bal(usdc, owner), 2 * T);
        await usdc.connect(owner).approve(legacy.address, 100_000_000);
        await usdc.connect(owner).approve(permit2.address, MAX);
        await permit2.connect(owner).approve(usdc.address, rail === "vault" ? vault.address : legacy.address, MAX160, now + 365 * DAY);
        await increase(DAY + 1);
        const ethBefore = await ethers.provider.getBalance(bene.address);
        const payEth = await ethers.provider.getBalance(payment.address);
        const uniUsdc = await bal(usdc, uni);

        const rc = await (await router.connect(bene).activeLegacyAndUnswap(legacyId, [usdc.address], 1, now + 7200 + DAY)).wait();
        const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
        // 100 swapped to 100 (mock rate 1:1) ETH units, fee 25 bps in ETH.
        assert.equal((await bal(usdc, uni)) - uniUsdc, 100_000_000, "only the direct allowance was swapped");
        assert.equal((await ethers.provider.getBalance(bene.address)).add(gas).sub(ethBefore).toNumber(), 100_000_000 - feeOf(100_000_000));
        assert.equal((await ethers.provider.getBalance(payment.address)).sub(payEth).toNumber(), feeOf(100_000_000));
        // The other 1,900 on the rail, fee 25 bps in the token.
        assert.equal(await bal(usdc, bene), 1_900_000_000 - feeOf(1_900_000_000));
        assert.equal(await bal(usdc, payment), feeOf(1_900_000_000));
        assert.equal(await bal(usdc, owner), 0);
        assert.equal(await legacy.eoaStorageToken(), ZERO);
      });
    }

    for (const [label, fixture, contractName] of [
      ["base clone at HEAD", waveA, "TransferEOALegacy"],
      ["v3, whole estate", v3, "TransferEOALegacyV3"],
    ] as const) {
      it(`${label}: a second claim after a refused fee distributes it as estate`, async function () {
        const f = await loadFixture(fixture);
        const a = await awkward(f);
        const { legacy, legacyId } = await createLegacyV2(f.router, f.owner, sixtyForty(f), { contractName });
        await a.connect(f.owner).approve(legacy.address, MAX);
        await a.setBlocked(f.payment.address, true);
        await increase(DAY + 1);
        await f.router.connect(f.bene).activeLegacy(legacyId, [a.address], false);
        const fee = feeOf(T);
        assert.equal(await bal(a, f.owner), fee, "the refused fee stayed in the wallet");

        await a.setBlocked(f.payment.address, false);
        await f.router.connect(f.bene2).activeLegacy(legacyId, [a.address], false);
        const net1 = T - fee;
        const net2 = fee - feeOf(fee);
        assert.equal(await bal(a, f.bene), sixty(net1) + sixty(net2));
        assert.equal(await bal(a, f.bene2), net1 - sixty(net1) + (net2 - sixty(net2)));
        assert.equal(await bal(a, f.payment), feeOf(fee), "the fee on the second claim only");
        assert.equal(await bal(a, f.owner), 0);
      });
    }

    it("v3 per-share: a blocklisted heir's payout fails, the share stays unrecorded and its backup claims it", async function () {
      const f = await loadFixture(v3);
      const a = await awkward(f);
      const { legacy, legacyId } = await perShare(f);
      await a.connect(f.owner).approve(legacy.address, MAX);
      await a.setBlocked(f.bene.address, true);
      await increase(DAY + 1);
      await f.router.connect(f.bene).activeLegacy(legacyId, [a.address], false);
      assert.equal((await legacy.released(a.address, f.bene.address)).toString(), "0");
      assert.equal(await legacy.shareOwner(f.bene.address), ZERO);
      assert.equal(await bal(a, f.owner), T);

      await increase(30 * DAY);
      await f.router.connect(f.bene3).activeLegacy(legacyId, [a.address], false);
      assert.equal(await bal(a, f.bene3), 600_000_000 - feeOf(600_000_000), "the backup takes A's share");
      assert.equal(await legacy.shareOwner(f.bene.address), f.bene3.address);
      await f.router.connect(f.bene2).activeLegacy(legacyId, [a.address], false);
      assert.equal(await bal(a, f.bene2), 400_000_000 - feeOf(400_000_000));
    });

    it("v3 per-share: an heir that refuses ETH gets nothing recorded; its backup claims the ETH share", async function () {
      const f = await loadFixture(v3);
      const heir = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
      await heir.setRejectAll(true);
      const dists = [
        { user: heir.address, percent: 600000 },
        { user: f.bene2.address, percent: 400000 },
      ];
      const { legacy, legacyId } = await perShare(f, dists);
      await f.owner.sendTransaction({ to: legacy.address, value: T });
      await increase(DAY + 1);
      await ethers.provider.send("hardhat_impersonateAccount", [heir.address]);
      await ethers.provider.send("hardhat_setBalance", [heir.address, "0x1000000000000000000"]);
      const asHeir = await ethers.getSigner(heir.address);
      await f.router.connect(asHeir).activeLegacy(legacyId, [], true);
      assert.equal((await legacy.released(ZERO, heir.address)).toString(), "0");
      assert.equal(await legacy.shareOwner(heir.address), ZERO);
      assert.equal((await ethers.provider.getBalance(legacy.address)).toNumber(), T);

      await increase(30 * DAY);
      const before = await ethers.provider.getBalance(f.bene3.address);
      const rc = await (await f.router.connect(f.bene3).activeLegacy(legacyId, [], true)).wait();
      const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
      assert.equal((await ethers.provider.getBalance(f.bene3.address)).add(gas).sub(before).toNumber(), 600_000_000 - feeOf(600_000_000));
      assert.equal(await legacy.shareOwner(heir.address), f.bene3.address);
    });

    it("v3 per-share: a fee receiver that burns all the gas it is given costs the claimant gas, never the claim", async function () {
      const f = await loadFixture(v3);
      const { legacy, legacyId } = await perShare(f);
      await f.owner.sendTransaction({ to: legacy.address, value: T });
      await ethers.provider.send("hardhat_setCode", [f.payment.address, BURN_ALL_GAS]);
      await increase(DAY + 1);
      const before = await ethers.provider.getBalance(f.bene.address);
      const rc = await (await f.router.connect(f.bene).activeLegacy(legacyId, [], true, { gasLimit: 10_000_000 })).wait();
      const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
      assert(rc.gasUsed.gt(9_000_000), `the fee call burned its share of the gas (${rc.gasUsed})`);
      assert.equal((await ethers.provider.getBalance(f.bene.address)).add(gas).sub(before).toNumber(), 600_000_000 - feeOf(600_000_000));
      assert.equal((await ethers.provider.getBalance(legacy.address)).toNumber(), 400_000_000 + feeOf(600_000_000), "the fee stays in the pot");
    });

    for (const [label, fixture, contractName, mode] of [
      ["base clone at HEAD, whole estate", waveA, "TransferEOALegacy", "whole"],
      ["v3 per-share", v3, "TransferEOALegacyV3", "share"],
    ] as const) {
      it(`${label}: a token that burns the gas of its transfer to Payment never blocks the heirs`, async function () {
        const f = await loadFixture(fixture);
        const w = await weird(f);
        const { legacy, legacyId } =
          mode === "share" ? await perShare(f) : await createLegacyV2(f.router, f.owner, sixtyForty(f), { contractName });
        await w.connect(f.owner).approve(legacy.address, MAX);
        await w.setGasBurner(f.payment.address);
        await increase(DAY + 1);
        const rc = await (await f.router.connect(f.bene).activeLegacy(legacyId, [w.address], false, { gasLimit: 10_000_000 })).wait();
        assert(rc.gasUsed.gt(9_000_000), `the fee transfer burned its share of the gas (${rc.gasUsed})`);
        assert.equal(await bal(w, f.payment), 0);
        if (mode === "share") {
          assert.equal(await bal(w, f.bene), 600_000_000 - feeOf(600_000_000));
        } else {
          const net = T - feeOf(T);
          assert.equal(await bal(w, f.bene), sixty(net));
          assert.equal(await bal(w, f.bene2), net - sixty(net));
          assert.equal(await bal(w, f.owner), feeOf(T), "the fee stays in the wallet");
        }
      });
    }
  });
});
