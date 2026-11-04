import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { increase } from "./utils/time";
import {
  DAY,
  deployTrain,
  createLegacyV2,
  expectRevert,
  signPermitBatch,
  EMPTY_BUNDLE,
} from "./fixtures/eoaTrain";

// LegacyPullVaultV2 (docs/plans/train-2026-11.md): checklist audit M-1 (owner
// unbind of a non-live binding), the timelock-only add-only implementation
// allowlist that lets the v3 clone share this vault, and the NFT rails' gate.
// Everything LegacyPullVault guaranteed must still hold.

describe("Train 2026-11 — LegacyPullVaultV2", function () {
  this.timeout(200000);

  const fixture = async () => deployTrain();

  async function impersonate(address: string) {
    await ethers.provider.send("hardhat_impersonateAccount", [address]);
    await ethers.provider.send("hardhat_setBalance", [address, "0x1000000000000000000"]);
    return ethers.getSigner(address);
  }

  /**
   * The M-1 race: L1 is activated and claimed while its owner is alive. The
   * owner signs a vault permit for their next legacy; a beneficiary of L1
   * lifts the signature from the mempool, registers it in Permit2 first and
   * claims through L1, which the vault still has bound to the owner.
   */
  async function frontRunAfterActivation(f: any, vault: any, unbindFirst: boolean) {
    const { owner, bene, attacker, router, permit2, permit2Domain, usdc } = f;
    await usdc.connect(owner).approve(permit2.address, ethers.constants.MaxUint256);
    const limited = await signPermitBatch(owner, permit2Domain, [usdc.address], vault.address, { amount: 100_000_000 });
    const { legacyId } = await createLegacyV2(router, owner, [{ user: attacker.address, percent: 1000000 }], { bundle: limited });
    await increase(DAY + 1);
    await router.connect(attacker).activeLegacy(legacyId, [usdc.address], false);
    void bene;

    if (unbindFirst) await vault.connect(owner).unbind();

    // The owner's next create carries a fresh unlimited permit (Permit2 nonce 1).
    const next = await signPermitBatch(owner, permit2Domain, [usdc.address], vault.address, { nonce: 1 });
    const stolenBefore = await usdc.balanceOf(attacker.address);
    await permit2.connect(attacker).permit(owner.address, next.permitBatch, next.signature);
    await router.connect(attacker).activeLegacy(legacyId, [usdc.address], false);
    return (await usdc.balanceOf(attacker.address)).sub(stolenBefore);
  }

  it("M-1 shown on vault v1: an activated legacy that stays bound pulls the owner's next permit", async function () {
    const f = await loadFixture(fixture);
    const v1 = await (await ethers.getContractFactory("LegacyPullVault")).deploy(f.router.address, f.impl.address);
    await f.router.connect(f.timelock).setPullVault(v1.address);
    const stolen = await frontRunAfterActivation(f, v1, false);
    assert(stolen.gt(800_000_000), `the old legacy's beneficiary pulls the rest of the wallet (${stolen})`);
  });

  it("M-1 closed on vault v2: after unbind() the front-run pulls nothing", async function () {
    const f = await loadFixture(fixture);
    const stolen = await frontRunAfterActivation(f, f.vault, true);
    assert.equal(stolen.toString(), "0");
    assert.equal(await f.vault.boundLegacy(f.owner.address), ethers.constants.AddressZero);

    // The owner still creates normally afterwards (an empty bundle, then a
    // fresh signature-less Permit2 approval for the vault).
    const { legacy } = await createLegacyV2(f.router, f.owner, [{ user: f.bene.address, percent: 1000000 }], { bundle: EMPTY_BUNDLE });
    assert.equal(await f.vault.boundLegacy(f.owner.address), legacy.address);
  });

  it("unbind: only the owner's own binding, never a live one, event emitted", async function () {
    const { owner, bene, attacker, router, vault } = await loadFixture(fixture);
    await expectRevert(vault.connect(owner).unbind(), "NotBound()");
    const { legacy, legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
    // A live binding cannot be cleared: a phished owner cannot break their own inheritance.
    await expectRevert(vault.connect(owner).unbind(), "BoundLegacyLive()");
    // Nobody else can unbind it either (they have no binding of their own).
    await expectRevert(vault.connect(attacker).unbind(), "NotBound()");

    await increase(DAY + 1);
    await router.connect(bene).activeLegacy(legacyId, [], true);
    const tx = await vault.connect(owner).unbind();
    const rc = await tx.wait();
    const ev = rc.events?.find((e: any) => e.event === "LegacyUnbound");
    assert(ev && ev.args!.owner === owner.address && ev.args!.legacy === legacy.address);
  });

  it("delete still releases the binding (unbind has nothing to do afterwards)", async function () {
    const { owner, bene, router, vault } = await loadFixture(fixture);
    const { legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
    await router.connect(owner).deleteLegacy(legacyId);
    assert.equal(await vault.boundLegacy(owner.address), ethers.constants.AddressZero);
    await expectRevert(vault.connect(owner).unbind(), "NotBound()");
  });

  describe("implementation allowlist", function () {
    it("starts with the constructor implementation; only the timelock adds; add-only; needs code", async function () {
      const { dev, timelock, attacker, impl, vault } = await loadFixture(fixture);
      assert.equal(await vault.cloneCodehash(), await vault.codehashOf(impl.address));
      assert.equal(await vault.isAllowedCodehash(await vault.codehashOf(impl.address)), true);

      const impl2 = await (await ethers.getContractFactory("TransferEOALegacy")).deploy();
      await expectRevert(vault.connect(dev).allowImplementation(impl2.address), "OnlyUpgradeTimelock()");
      await expectRevert(vault.connect(attacker).allowImplementation(impl2.address), "OnlyUpgradeTimelock()");
      await expectRevert(vault.connect(timelock).allowImplementation(attacker.address), "NoCode()");
      await expectRevert(vault.connect(timelock).allowImplementation(impl.address), "AlreadyAllowed()");
      await vault.connect(timelock).allowImplementation(impl2.address);
      assert.equal(await vault.isAllowedCodehash(await vault.codehashOf(impl2.address)), true);
      assert.equal(await vault.isAllowedCodehash(await vault.codehashOf(impl.address)), true, "never removed");
    });

    it("a clone of an implementation the vault does not know cannot be bound, so the create fails", async function () {
      const { owner, bene, timelock, router } = await loadFixture(fixture);
      const impl2 = await (await ethers.getContractFactory("TransferEOALegacy")).deploy();
      await router.connect(timelock).setLegacyImplementation(impl2.address);
      let caught: any;
      try {
        await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      } catch (e) {
        caught = e;
      }
      assert(caught, "binding an unknown codehash must fail the create");
    });

    it("after allowImplementation, clones of both implementations bind and pull", async function () {
      const { owner, other, bene, timelock, router, vault, permit2, permit2Domain, usdc } = await loadFixture(fixture);
      const a = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);

      const impl2 = await (await ethers.getContractFactory("TransferEOALegacy")).deploy();
      await vault.connect(timelock).allowImplementation(impl2.address);
      await router.connect(timelock).setLegacyImplementation(impl2.address);
      await usdc.mint(other.address, 500_000_000);
      await usdc.connect(other).approve(permit2.address, ethers.constants.MaxUint256);
      const bundle = await signPermitBatch(other, permit2Domain, [usdc.address], vault.address);
      const b = await createLegacyV2(router, other, [{ user: bene.address, percent: 1000000 }], { bundle });
      assert.equal(await vault.boundLegacy(owner.address), a.legacy.address);
      assert.equal(await vault.boundLegacy(other.address), b.legacy.address);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(b.legacyId, [usdc.address], false);
      assert((await usdc.balanceOf(bene.address)).gt(490_000_000), "the second implementation's clone pulled through the vault");
    });
  });

  describe("unchanged guarantees", function () {
    it("bind is router-only and never replaces a live binding", async function () {
      const { owner, bene, attacker, router, vault } = await loadFixture(fixture);
      const { legacy } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      await expectRevert(vault.connect(attacker).bind(owner.address, legacy.address), "OnlyRouter()");
      const routerSigner = await impersonate(router.address);
      await expectRevert(vault.connect(routerSigner).bind(owner.address, legacy.address), "AlreadyBound()");
      await expectRevert(vault.connect(routerSigner).bind(owner.address, attacker.address), "NotPinnedClone()");
    });

    it("pull, release and the NFT rails answer only to the bound legacy", async function () {
      const { owner, bene, attacker, router, vault, usdc } = await loadFixture(fixture);
      await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      await expectRevert(vault.connect(attacker).pull(owner.address, usdc.address, attacker.address, 1), "OnlyBoundLegacy()");
      await expectRevert(vault.connect(attacker).release(owner.address), "OnlyBoundLegacy()");
      await expectRevert(vault.connect(attacker).pullERC721(owner.address, usdc.address, attacker.address, 1), "OnlyBoundLegacy()");
      await expectRevert(vault.connect(attacker).pullERC1155(owner.address, usdc.address, attacker.address, 1, 1), "OnlyBoundLegacy()");
    });
  });
});
