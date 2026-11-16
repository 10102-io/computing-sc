import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// The router's create flag (`isCreateLegacy[owner]`, one live wallet legacy
// per owner) and what may release it (checklist audit RC-L, found
// 2026-11-11): only the claim that ends a legacy, never a later claim on
// it, and `releaseCreateFlag` only while the vault holds no live legacy for
// the owner. Before, every claim cleared the flag, also when the owner had
// created the next legacy in between.

const ERC721 = 1;

describe("Router create flag", function () {
  this.timeout(300000);

  const fixture = async () => deployTrain();
  const v3Options = { implName: "TransferEOALegacyV3", implArgs: (c: any) => [c.nftAllowlist], withNftAllowlist: true };

  async function v3Fixture() {
    const f = await deployTrain(v3Options);
    const nft721 = await (await ethers.getContractFactory("MockERC721")).deploy();
    await nft721.mint(f.owner.address, 1); // id 0
    await f.nftAllowlist.connect(f.dev).addCollection(nft721.address);
    return { ...f, nft721 };
  }

  const all = (who: any) => [{ user: who.address, percent: 1000000 }];
  const halves = (a: any, b: any) => [
    { user: a.address, percent: 500000 },
    { user: b.address, percent: 500000 },
  ];

  /** Legacy A is claimed (and so ended) by `bene`; the owner then creates legacy B. */
  async function endedThenRecreated(f: any) {
    const { owner, bene, bene2, other, router } = f;
    const a = await createLegacyV2(router, owner, halves(bene, bene2));
    await increase(DAY + 1);
    await router.connect(bene).activeLegacy(a.legacyId, [], true);
    assert.equal(await a.legacy.isLive(), false);
    assert.equal(await router.isCreateLegacy(owner.address), false, "the claim that ends A releases the owner");
    const b = await createLegacyV2(router, owner, all(other));
    assert.equal(await router.isCreateLegacy(owner.address), true);
    return { a, b };
  }

  describe("claims", function () {
    it("the claim that ends a legacy releases its owner, who can create the next one", async function () {
      const f = await loadFixture(fixture);
      const { b } = await endedThenRecreated(f);
      assert.equal(await b.legacy.isLive(), true);
      assert.equal(await f.vault.boundLegacy(f.owner.address), b.legacy.address);
    });

    it("a later claim on the ended legacy leaves the flag of the owner's next legacy", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, other, router, usdt } = f;
      const { a, b } = await endedThenRecreated(f);

      // ETH again, and a token the owner approved to A directly: both are ordinary later claims.
      await router.connect(bene2).activeLegacy(a.legacyId, [], true);
      assert.equal(await router.isCreateLegacy(owner.address), true, "an ETH claim on the ended legacy");
      await usdt.connect(owner).approve(a.legacy.address, 400_000_000);
      const before = await usdt.balanceOf(bene.address);
      await router.connect(bene).activeLegacy(a.legacyId, [usdt.address], false);
      assert((await usdt.balanceOf(bene.address)).gt(before), "the later claim itself still pays");
      assert.equal(await router.isCreateLegacy(owner.address), true, "a token claim on the ended legacy");

      // The router itself refuses the next create now, not only the vault.
      const ts = await currentTime();
      const extra = { lackOfOutgoingTxRange: DAY, delayLayer2: 0, delayLayer3: 0 };
      const zero = { user: ethers.constants.AddressZero, percent: 0 };
      const bundle = { permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 }, signature: "0x" };
      await expectRevert(router.connect(owner).createLegacyV2(all(other), extra, zero, zero, bundle, ts, "0x"), "SenderIsCreatedLegacy(address)");

      // B is untouched and ends like any legacy: its claim releases the owner.
      assert.equal(await b.legacy.isLive(), true);
      await increase(DAY + 1);
      await router.connect(other).activeLegacy(b.legacyId, [], true);
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });

    it("the same through the unswap claim: it releases on the claim that ends the legacy only", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, other, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await increase(DAY + 1);
      const deadline = (await currentTime()) + 3600;
      await router.connect(bene).activeLegacyAndUnswap(a.legacyId, [], 0, deadline);
      assert.equal(await router.isCreateLegacy(owner.address), false);

      await createLegacyV2(router, owner, all(other));
      await router.connect(bene).activeLegacyAndUnswap(a.legacyId, [], 0, deadline);
      assert.equal(await router.isCreateLegacy(owner.address), true);
    });

    it("a legacy that does not answer isLive() is claimed all the same, and releases as before", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      const mock = await (await ethers.getContractFactory("MockLegacyWithoutIsLive")).deploy(owner.address);
      await ethers.provider.send("hardhat_setCode", [a.legacy.address, await ethers.provider.getCode(mock.address)]);
      await expectRevert(a.legacy.isLive(), "");

      const planted = await ethers.getContractAt("MockLegacyWithoutIsLive", a.legacy.address);
      const rc = await (await router.connect(bene).activeLegacy(a.legacyId, [], true)).wait();
      const claimed = rc.logs.filter((l: any) => l.address === a.legacy.address).map((l: any) => planted.interface.parseLog(l));
      assert.equal(claimed.length, 1);
      assert.equal(claimed[0].args.beneficiary, bene.address);
      assert.equal(await router.isCreateLegacy(owner.address), false);

      const deadline = (await currentTime()) + 3600;
      await router.connect(bene).activeLegacyAndUnswap(a.legacyId, [], 0, deadline);
    });
  });

  describe("releaseCreateFlag", function () {
    it("owner only, never on a live legacy, a no-op on an ended one", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, attacker, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await expectRevert(router.connect(attacker).releaseCreateFlag(a.legacyId), "OnlyOwner()");
      await expectRevert(router.connect(owner).releaseCreateFlag(a.legacyId), "LegacyStillActive()");
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(a.legacyId, [], true);

      const rc = await (await router.connect(owner).releaseCreateFlag(a.legacyId)).wait();
      const ev = rc.events?.find((e: any) => e.event === "TransferEOALegacyCreateFlagReleased");
      assert(ev && ev.args!.owner === owner.address && ev.args!.legacyId.eq(a.legacyId));
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });

    it("refused while the vault holds a live legacy for the owner: an ended legacy cannot release the next one's flag", async function () {
      const f = await loadFixture(fixture);
      const { owner, other, router } = f;
      const { a, b } = await endedThenRecreated(f);
      await expectRevert(router.connect(owner).releaseCreateFlag(a.legacyId), "LegacyStillActive()");
      assert.equal(await router.isCreateLegacy(owner.address), true);

      // Once B has ended too, either id releases (a no-op by then).
      await increase(DAY + 1);
      await router.connect(other).activeLegacy(b.legacyId, [], true);
      await router.connect(owner).releaseCreateFlag(a.legacyId);
      await router.connect(owner).releaseCreateFlag(b.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });

    it("a deleted legacy: delete releases, and a second delete or a release cannot touch the next legacy's flag", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, other, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await router.connect(owner).deleteLegacy(a.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
      await createLegacyV2(router, owner, all(other));

      let caught: any;
      try {
        await router.connect(owner).deleteLegacy(a.legacyId);
      } catch (e) {
        caught = e;
      }
      assert(caught, "a deleted legacy cannot be deleted again");
      await expectRevert(router.connect(owner).releaseCreateFlag(a.legacyId), "LegacyStillActive()");
      assert.equal(await router.isCreateLegacy(owner.address), true);
    });

    it("legacy v3 ended by an NFT claim: the flag stays until the owner releases it, also after a later token claim", async function () {
      const f = await loadFixture(v3Fixture);
      const { owner, bene, other, router, vault, nft721 } = f;
      const a = await createLegacyV2(router, owner, all(bene), { contractName: "TransferEOALegacyV3" });
      await a.legacy.connect(owner).setNftItems([{ collection: nft721.address, kind: ERC721, tokenId: 0, amount: 1, beneficiary: bene.address }]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);

      // The NFT claim goes to the legacy, not through the router: nothing releases the flag.
      await a.legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene.address);
      assert.equal(await a.legacy.isLive(), false);
      assert.equal(await router.isCreateLegacy(owner.address), true);

      // A token claim through the router afterwards is a later claim: it does not release either.
      await router.connect(bene).activeLegacy(a.legacyId, [], true);
      assert.equal(await router.isCreateLegacy(owner.address), true);

      // The owner's own release does, and the next legacy can be created.
      await router.connect(owner).releaseCreateFlag(a.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
      const b = await createLegacyV2(router, owner, all(other), { contractName: "TransferEOALegacyV3" });
      assert.equal(await vault.boundLegacy(owner.address), b.legacy.address);
    });

    it("without a pull vault the release works as it always did", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, router, timelock } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(a.legacyId, [], true);
      await router.connect(timelock).setPullVault(ethers.constants.AddressZero);
      await router.connect(owner).releaseCreateFlag(a.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });
  });
});
