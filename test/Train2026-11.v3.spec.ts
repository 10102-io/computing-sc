import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// Wave B (docs/plans/train-2026-11.md): the TransferEOALegacyV3 clone, its
// NftCollectionWhiteList, and its rollout onto LegacyPullVaultV2. Isolated for
// the independent audit: everything here is a new file or a new spec.

const MAX = ethers.constants.MaxUint256;
const ZERO = ethers.constants.AddressZero;

describe("Train 2026-11 — wave B legacy v3", function () {
  this.timeout(300000);

  const v3Options = { implName: "TransferEOALegacyV3", implArgs: (c: any) => [c.nftAllowlist], withNftAllowlist: true };

  async function fixture() {
    const f = await deployTrain(v3Options);
    const nft721 = await (await ethers.getContractFactory("MockERC721")).deploy();
    const nft1155 = await (await ethers.getContractFactory("MockERC1155")).deploy();
    await nft721.mint(f.owner.address, 2); // ids 0, 1
    await nft1155.mint(f.owner.address, 5); // id 0 x5
    await f.nftAllowlist.connect(f.dev).addCollection(nft721.address);
    await f.nftAllowlist.connect(f.dev).addCollection(nft1155.address);
    return { ...f, nft721, nft1155 };
  }

  async function createV3(f: any, distributions: any[], o: any = {}) {
    return createLegacyV2(f.router, f.owner, distributions, { contractName: "TransferEOALegacyV3", ...o });
  }

  const sixtyForty = (f: any) => [
    { user: f.bene.address, percent: 600000 },
    { user: f.bene2.address, percent: 400000 },
  ];

  describe("NftCollectionWhiteList", function () {
    it("admin-only, NFTs only, kinds recorded, removable", async function () {
      const { dev, attacker, nftAllowlist, nft721, nft1155, usdc } = await loadFixture(fixture);
      assert.equal(await nftAllowlist.kindOf(nft721.address), 1);
      assert.equal(await nftAllowlist.kindOf(nft1155.address), 2);
      await expectRevert(nftAllowlist.connect(attacker).addCollection(usdc.address), "AccessControlUnauthorizedAccount(address,bytes32)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(usdc.address), "NotAnNftCollection(address)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(attacker.address), "NotAnNftCollection(address)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(nft721.address), "AlreadyAllowed(address)");
      await nftAllowlist.connect(dev).removeCollection(nft721.address);
      assert.deepEqual(await nftAllowlist.getCollections(), [nft1155.address]);
    });
  });

  describe("NFT items", function () {
    it("only the owner names items; collections must be allowed; ERC-721 amount 1; first-line beneficiaries only", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, attacker, nft721, nft1155, usdc } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      const ok = { collection: nft721.address, tokenId: 0, amount: 1, beneficiary: bene.address };
      await expectRevert(legacy.connect(attacker).setNftItems([ok]), "OnlyOwner()");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, collection: usdc.address }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, amount: 2 }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, beneficiary: attacker.address }]), "NftItemInvalid(uint256)");
      await expectRevert(
        legacy.connect(owner).setNftItems([{ collection: nft1155.address, tokenId: 0, amount: 0, beneficiary: bene.address }]),
        "NftItemInvalid(uint256)"
      );
      await expectRevert(legacy.connect(owner).setNftItems(Array(51).fill(ok)), "TooManyNftItems()");
      await legacy.connect(owner).setNftItems([ok]);
      assert.equal((await legacy.nftItemCount()).toString(), "1");
    });

    it("claim through the vault: each item reaches its named beneficiary, once", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, attacker, vault, nft721, nft1155 } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([
        { collection: nft721.address, tokenId: 0, amount: 1, beneficiary: bene.address },
        { collection: nft1155.address, tokenId: 0, amount: 3, beneficiary: bene2.address },
      ]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await nft1155.connect(owner).setApprovalForAll(vault.address, true);

      await expectRevert(legacy.connect(bene).claimNfts([0, 1]), "NotEnoughContitionalActive()");
      await increase(DAY + 1);
      await expectRevert(legacy.connect(attacker).claimNfts([0, 1]), "NotBeneficiary()");
      // Any first-line beneficiary triggers; the payee is fixed by the item.
      await legacy.connect(bene2).claimNfts([0, 1]);
      assert.equal(await nft721.ownerOf(0), bene.address);
      assert.equal((await nft1155.balanceOf(bene2.address, 0)).toString(), "3");
      assert.equal((await nft1155.balanceOf(owner.address, 0)).toString(), "2");
      assert.equal(await legacy.isLive(), false, "an NFT claim activates the legacy");
      const [, claimed] = await legacy.nftItem(1);
      assert.equal(claimed, true);
      await legacy.connect(bene).claimNfts([0, 1]); // no-op, nothing moves twice
      assert.equal((await nft1155.balanceOf(bene2.address, 0)).toString(), "3");
    });

    it("direct approval rail, partial ERC-1155 balance, failures skipped, delisted collection still claimable", async function () {
      const f = await loadFixture(fixture);
      const { owner, dev, bene, nftAllowlist, nft721, nft1155 } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([
        { collection: nft721.address, tokenId: 1, amount: 1, beneficiary: bene.address },
        { collection: nft1155.address, tokenId: 0, amount: 9, beneficiary: bene.address },
      ]);
      await nft1155.connect(owner).setApprovalForAll(legacy.address, true);
      await nftAllowlist.connect(dev).removeCollection(nft1155.address);
      await increase(DAY + 1);
      // The ERC-721 is not approved anywhere: skipped, the batch still lands.
      await legacy.connect(bene).claimNfts([0, 1]);
      assert.equal((await nft1155.balanceOf(bene.address, 0)).toString(), "5", "all the owner held, capped by the item");
      assert.equal(await nft721.ownerOf(1), owner.address);
      // A later approval (an alive owner, say) lets the skipped item through.
      await nft721.connect(owner).setApprovalForAll(legacy.address, true);
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(1), bene.address);
    });

    it("a second-line beneficiary in its period takes every item", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, vault, nft721 } = f;
      const { legacy } = await createV3(f, [{ user: bene.address, percent: 1000000 }], {
        layer2: { user: bene3.address, percent: 1000000 },
        delayLayer2: 10 * DAY,
      });
      await legacy.connect(owner).setNftItems([{ collection: nft721.address, tokenId: 0, amount: 1, beneficiary: bene.address }]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);
      await expectRevert(legacy.connect(bene3).claimNfts([0]), "NotBeneficiary()");
      await increase(10 * DAY);
      await legacy.connect(bene3).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene3.address);
    });

    it("changing the first line voids the items", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, router, nft721 } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([{ collection: nft721.address, tokenId: 0, amount: 1, beneficiary: bene.address }]);
      await router.connect(owner).setLegacyDistributions(legacyId, [""], [{ user: bene.address, percent: 1000000 }]);
      assert.equal((await legacy.nftItemCount()).toString(), "0");
    });
  });

  describe("per-beneficiary backup lines", function () {
    async function withLines() {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await usdc.connect(owner).approve(legacy.address, MAX);
      return { ...f, legacy, legacyId };
    }

    it("validation: premium, delay bounds, first-line primaries, backups never the owner, a beneficiary, the executor or twice", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, other, premiumSetting, dev } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      const line = (o: any = {}) => ({ primary: bene.address, second: bene3.address, third: ZERO, ...o });
      await expectRevert(legacy.connect(owner).setBackupLines(29 * DAY, [line()]), "BackupDelayInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(0, [line()]), "BackupDelayInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ primary: other.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: owner.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: bene2.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: ZERO })]), "BackupLineInvalid()");
      await expectRevert(
        legacy.connect(owner).setBackupLines(30 * DAY, [line(), line({ primary: bene2.address })]),
        "BackupLineInvalid()"
      );
      await legacy.connect(owner).setExecutor(other.address);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: other.address })]), "BackupLineInvalid()");
      await premiumSetting.connect(dev).resetPremium(owner.address);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line()]), "NotPremium()");
    });

    it("each share is claimed by its own line: B takes only B's share, A2 waits for the delay, then takes A's", async function () {
      const { bene, bene2, bene3, router, legacy, legacyId, usdc, owner } = await withLines();
      assert.equal(await legacy.getBeneficiaryLayer(bene3.address), 1);
      await increase(DAY + 1);
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "399000000", "40% less the 25 bps fee");
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "0", "A's share is not pushed to A");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "600000000");

      await expectRevert(router.connect(bene3).activeLegacy(legacyId, [usdc.address], false), "BackupNotYet(uint256)");
      await increase(30 * DAY);
      await router.connect(bene3).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene3.address)).toString(), "598500000");
      // A is too late for this round; nothing is paid twice.
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "0");
      assert.equal((await legacy.claimedMask(usdc.address)).toString(), "3");
    });

    it("the primary keeps priority until someone in the line claims; a new inflow opens a new round", async function () {
      const { bene, bene2, router, legacy, legacyId, usdc, owner } = await withLines();
      await increase(DAY + 31 * DAY); // A2's window is open too
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "598500000");
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "399000000");
      // Funds that arrive after every share was paid are split again.
      await usdc.mint(owner.address, 100_000_000);
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), String(399000000 + 39900000));
      void legacy;
    });

    it("ETH shares work the same way", async function () {
      const { owner, bene, bene2, bene3, router, legacy, legacyId } = await withLines();
      await owner.sendTransaction({ to: legacy.address, value: 1_000_000_000 });
      await increase(DAY + 1);
      const before = await ethers.provider.getBalance(legacy.address);
      await router.connect(bene2).activeLegacy(legacyId, [], true);
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), before.sub(400_000_000).toString());
      await increase(30 * DAY);
      await router.connect(bene3).activeLegacy(legacyId, [], true);
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), "0");
      void bene;
    });

    it("the whole-estate second line still works in per-share mode", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, other, router, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 61 * DAY);
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(other.address)).toString(), "997500000");
      void bene2;
    });

    it("changing the first line voids the lines and turns per-share mode off", async function () {
      const { owner, bene, bene3, router, legacy, legacyId } = await withLines();
      await router.connect(owner).setLegacyDistributions(legacyId, [""], [{ user: bene.address, percent: 1000000 }]);
      assert.equal((await legacy.backupDelay()).toString(), "0");
      assert.equal(await legacy.getBeneficiaryLayer(bene3.address), 0);
    });
  });

  describe("executor", function () {
    async function withExecutor() {
      const f = await loadFixture(fixture);
      const { owner, bene, other, usdc } = f;
      const { legacy, legacyId } = await createV3(f, [{ user: bene.address, percent: 1000000 }], { trigger: 365 * DAY });
      await legacy.connect(owner).setExecutor(other.address);
      await usdc.connect(owner).approve(legacy.address, MAX);
      return { ...f, legacy, legacyId, executor: other };
    }

    it("the executor can never be the owner, a beneficiary, or become one later", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, other, router } = f;
      const { legacy, legacyId } = await createV3(f, [{ user: bene.address, percent: 1000000 }]);
      await expectRevert(legacy.connect(owner).setExecutor(owner.address), "ExecutorInvalid()");
      await expectRevert(legacy.connect(owner).setExecutor(bene.address), "ExecutorInvalid()");
      await expectRevert(legacy.connect(other).setExecutor(other.address), "OnlyOwner()");
      await legacy.connect(owner).setExecutor(other.address);
      let caught: any;
      try {
        await router.connect(owner).setLegacyDistributions(legacyId, [""], [{ user: other.address, percent: 1000000 }]);
      } catch (e) {
        caught = e;
      }
      assert(caught, "naming the executor as a beneficiary must revert");
    });

    it("an attestation brings claims forward to 30 days, and the executor receives nothing", async function () {
      const { bene, router, legacy, legacyId, executor, usdc } = await withExecutor();
      await expectRevert(legacy.connect(bene).attestDeath(), "NotExecutor()");
      await legacy.connect(executor).attestDeath();
      const [deadline] = await legacy.getTriggerActivationTimestamp();
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      assert.equal(deadline.toNumber(), now + 30 * DAY);
      await increase(30 * DAY);
      await expectRevert(router.connect(executor).activeLegacy(legacyId, [usdc.address], false), "OnlyBeneficaries()");
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "997500000");
      assert.equal((await usdc.balanceOf(executor.address)).toString(), "0");
    });

    it("any owner check-in during the grace period cancels the attestation", async function () {
      const { owner, bene, router, legacy, legacyId, executor, usdc } = await withExecutor();
      await legacy.connect(executor).attestDeath();
      await increase(10 * DAY);
      await router.connect(owner).avtiveAlive(legacyId);
      // At most one attestation per grace period, even once cancelled.
      await expectRevert(legacy.connect(executor).attestDeath(), "AttestationNotAllowed()");
      await increase(21 * DAY);
      await expectRevert(router.connect(bene).activeLegacy(legacyId, [usdc.address], false), "NotEnoughContitionalActive()");
      await legacy.connect(executor).attestDeath();
    });

    it("the dead-owner test: without the executor, claims open at the normal deadline", async function () {
      const { bene, router, legacyId, usdc } = await withExecutor();
      await increase(365 * DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "997500000");
    });

    it("no attestation on a deleted or already claimable legacy; removing the executor clears one", async function () {
      const { owner, router, legacy, legacyId, executor } = await withExecutor();
      await legacy.connect(executor).attestDeath();
      await legacy.connect(owner).setExecutor(ZERO);
      assert.equal((await legacy.deathAttestedAt()).toString(), "0");
      await expectRevert(legacy.connect(executor).attestDeath(), "NotExecutor()");
      await legacy.connect(owner).setExecutor(executor.address);
      await router.connect(owner).deleteLegacy(legacyId);
      await expectRevert(legacy.connect(executor).attestDeath(), "AttestationNotAllowed()");
    });
  });

  describe("rollout onto wave A", function () {
    it("the timelock adds v3 to vault v2 and points new creates at it; wave A legacies are untouched", async function () {
      const f = await deployTrain(); // wave A state: vault v2 knows only the wave A clone
      const { owner, other, bene, timelock, dev, router, vault, usdc } = f;
      const a = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);

      const list = await (await ethers.getContractFactory("NftCollectionWhiteList")).deploy(dev.address);
      const v3 = await (await ethers.getContractFactory("TransferEOALegacyV3")).deploy(list.address);
      await expectRevert(vault.connect(dev).allowImplementation(v3.address), "OnlyUpgradeTimelock()");
      await vault.connect(timelock).allowImplementation(v3.address);
      await router.connect(timelock).setLegacyImplementation(v3.address);

      const b = await createLegacyV2(router, other, [{ user: bene.address, percent: 1000000 }], { contractName: "TransferEOALegacyV3" });
      assert.equal(await vault.boundLegacy(other.address), b.legacy.address);
      assert.equal(await b.legacy.nftAllowlist(), list.address);
      assert.equal(await vault.boundLegacy(owner.address), a.legacy.address);

      await usdc.connect(owner).approve(a.legacy.address, MAX);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(a.legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "997500000");
    });
  });
});
