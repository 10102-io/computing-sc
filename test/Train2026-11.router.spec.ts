import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// TransferEOALegacyRouter, wave A (docs/plans/train-2026-11.md): checklist
// audit M-3 (rotation levers behind the UpgradeTimelock, setCreatePaused on
// the fast code admin), initializeV4 (code admin to the Safe, Sepolia Payment
// repoint), and the per-attestor nonce baseline's storage.

const INITIALIZABLE_STORAGE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function initializedVersion(proxy: string): Promise<number> {
  const packed = await ethers.provider.getStorageAt(proxy, INITIALIZABLE_STORAGE_SLOT);
  return Number(BigInt("0x" + packed.slice(-16)));
}

describe("Train 2026-11 — TransferEOALegacyRouter (wave A)", function () {
  this.timeout(200000);

  const fixture = async () => deployTrain();

  describe("M-3: rotation levers only through the UpgradeTimelock", function () {
    it("the code admin and anyone else are refused on all four levers", async function () {
      const { dev, attacker, router, impl } = await loadFixture(fixture);
      for (const signer of [dev, attacker]) {
        await expectRevert(router.connect(signer).setLegacyImplementation(impl.address), "NotUpgradeTimelock()");
        await expectRevert(router.connect(signer).setPullVault(attacker.address), "NotUpgradeTimelock()");
        await expectRevert(router.connect(signer).setActivityAttestor(attacker.address), "NotUpgradeTimelock()");
        await expectRevert(router.connect(signer).setLegacyCreationCode("0x6000"), "NotUpgradeTimelock()");
      }
    });

    it("the timelock moves them, each with an event the worker can alert on", async function () {
      const { timelock, attacker, router, impl, vault } = await loadFixture(fixture);
      const expectEvent = async (p: Promise<any>, name: string) => {
        const rc = await (await p).wait();
        assert(rc.events?.some((e: any) => e.event === name), `${name} missing`);
      };
      await expectEvent(router.connect(timelock).setLegacyImplementation(impl.address), "LegacyImplementationSet");
      await expectEvent(router.connect(timelock).setPullVault(vault.address), "PullVaultSet");
      await expectEvent(router.connect(timelock).setActivityAttestor(attacker.address), "ActivityAttestorSet");
      await expectEvent(router.connect(timelock).setLegacyCreationCode("0x6000"), "LegacyCreationCodeSet");
      assert.equal(await router.activityAttestor(), attacker.address);
    });

    it("setCreatePaused stays on the fast code admin, and the timelock is not the code admin", async function () {
      const { dev, timelock, owner, bene, router } = await loadFixture(fixture);
      await expectRevert(router.connect(timelock).setCreatePaused(true), "NotCodeAdmin()");
      await router.connect(dev).setCreatePaused(true);
      let caught: any;
      try {
        await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      } catch (e) {
        caught = e;
      }
      assert(caught, "create paused");
      await router.connect(dev).setCreatePaused(false);
      await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
    });

    it("the timelock address lives in the implementation's code, not in proxy storage", async function () {
      const { timelock, router } = await loadFixture(fixture);
      assert.equal(await router.upgradeTimelock(), timelock.address);
      const Router = await ethers.getContractFactory("TransferEOALegacyRouter");
      await expectRevert(Router.deploy(ethers.constants.AddressZero), "InvalidInitialization()");
    });
  });

  describe("initializeV4 (reinitializer(5), timelock only)", function () {
    it("only the timelock can run it; it hands setCreatePaused to the Safe", async function () {
      const { dev, timelock, safe, router } = await loadFixture(fixture);
      await expectRevert(router.connect(dev).initializeV4(safe.address, ethers.constants.AddressZero), "NotUpgradeTimelock()");
      await expectRevert(router.connect(safe).initializeV4(safe.address, ethers.constants.AddressZero), "NotUpgradeTimelock()");
      const rc = await (await router.connect(timelock).initializeV4(safe.address, ethers.constants.AddressZero)).wait();
      assert(rc.events?.some((e: any) => e.event === "CodeAdminSet"));
      assert.equal(await initializedVersion(router.address), 5);

      await router.connect(safe).setCreatePaused(true);
      await expectRevert(router.connect(dev).setCreatePaused(false), "NotCodeAdmin()");
      await expectRevert(router.connect(timelock).initializeV4(safe.address, ethers.constants.AddressZero), "InvalidInitialization()");
    });

    it("works from the mainnet counter (4, after initializeV3) and from Sepolia's (3)", async function () {
      const { dev, timelock, safe, router } = await loadFixture(fixture);
      assert.equal(await initializedVersion(router.address), 3, "fixture ran initializeV2: Sepolia-like");
      await router.connect(dev).initializeV3(dev.address);
      assert.equal(await initializedVersion(router.address), 4, "mainnet-like");
      await router.connect(timelock).initializeV4(safe.address, ethers.constants.AddressZero);
      assert.equal(await initializedVersion(router.address), 5);
    });

    it("repoints Payment only when given one (Sepolia), never to zero", async function () {
      const { timelock, safe, router, payment } = await loadFixture(fixture);
      const other = await (await ethers.getContractFactory("Payment")).deploy();
      await router.connect(timelock).initializeV4(safe.address, other.address);
      assert.equal(await router.paymentContract(), other.address);
      assert.notEqual(other.address, payment.address);
      await expectRevert(router.connect(timelock).initializeV4(ethers.constants.AddressZero, ethers.constants.AddressZero), "InvalidInitialization()");
    });

    it("a zero Payment argument leaves the current one in place", async function () {
      const { timelock, safe, router, payment } = await loadFixture(fixture);
      await router.connect(timelock).initializeV4(safe.address, ethers.constants.AddressZero);
      assert.equal(await router.paymentContract(), payment.address);
    });
  });

  describe("auto-renew-nonce-baseline", function () {
    it("baselines are per attestor; the latest observation still shows in autoRenewState", async function () {
      const { owner, bene, attestor, other, timelock, router } = await loadFixture(fixture);
      const { legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }], { trigger: 90 * DAY });
      await router.connect(owner).setAutoRenew(legacyId, true);
      await ethers.provider.send("evm_increaseTime", [65 * DAY]);
      await ethers.provider.send("evm_mine", []);
      await router.connect(attestor).recordActivity(legacyId, 10);
      assert.equal((await router.attestorNonceSeen(legacyId, attestor.address)).toString(), "10");
      assert.equal((await router.autoRenewState(legacyId)).lastNonceSeen.toString(), "10");
      assert.equal((await router.attestorNonceSeen(legacyId, other.address)).toString(), "0");
      void timelock;
    });
  });
});
