import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// Wave B (docs/plans/train-2026-11.md): the TransferEOALegacyV3 clone, its
// NftCollectionWhiteList, and its rollout onto LegacyPullVaultV2, with the
// review round 1 fixes (H-1 running-total shares, L-1 to L-5, info items).

const MAX = ethers.constants.MaxUint256;
const ZERO = ethers.constants.AddressZero;
const ERC721 = 1;
const ERC1155 = 2;

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

  const item = (collection: string, kind: number, tokenId: number, amount: number, beneficiary: string) => ({
    collection,
    kind,
    tokenId,
    amount,
    beneficiary,
  });

  describe("NftCollectionWhiteList", function () {
    it("admin-only, NFTs only, kinds recorded, removable", async function () {
      const { dev, attacker, nftAllowlist, nft721, nft1155, usdc } = await loadFixture(fixture);
      assert.equal(await nftAllowlist.kindOf(nft721.address), ERC721);
      assert.equal(await nftAllowlist.kindOf(nft1155.address), ERC1155);
      await expectRevert(nftAllowlist.connect(attacker).addCollection(usdc.address), "AccessControlUnauthorizedAccount(address,bytes32)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(usdc.address), "NotAnNftCollection(address)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(attacker.address), "NotAnNftCollection(address)");
      await expectRevert(nftAllowlist.connect(dev).addCollection(nft721.address), "AlreadyAllowed(address)");
      await nftAllowlist.connect(dev).removeCollection(nft721.address);
      assert.deepEqual(await nftAllowlist.getCollections(), [nft1155.address]);
    });
  });

  describe("NFT items", function () {
    it("only the owner names items; allowed collection with its kind; ERC-721 amount 1; first-line beneficiaries only; open to non-Premium owners", async function () {
      const f = await loadFixture(fixture);
      const { owner, dev, bene, attacker, nft721, nft1155, usdc, premiumSetting } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      const ok = item(nft721.address, ERC721, 0, 1, bene.address);
      await expectRevert(legacy.connect(attacker).setNftItems([ok]), "OnlyOwner()");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, collection: usdc.address }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, kind: ERC1155 }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, amount: 2 }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([{ ...ok, beneficiary: attacker.address }]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems([item(nft1155.address, ERC1155, 0, 0, bene.address)]), "NftItemInvalid(uint256)");
      await expectRevert(legacy.connect(owner).setNftItems(Array(51).fill(ok)), "TooManyNftItems()");
      await premiumSetting.connect(dev).resetPremium(owner.address);
      await legacy.connect(owner).setNftItems([ok]);
      assert.equal((await legacy.nftItem(0)).item.beneficiary, bene.address);
    });

    it("claim through the vault: each item reaches its named beneficiary, once; activation is evented", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, attacker, vault, nft721, nft1155 } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([
        item(nft721.address, ERC721, 0, 1, bene.address),
        item(nft1155.address, ERC1155, 0, 3, bene2.address),
      ]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await nft1155.connect(owner).setApprovalForAll(vault.address, true);

      await expectRevert(legacy.connect(bene).claimNfts([0, 1]), "NotEnoughContitionalActive()");
      await increase(DAY + 1);
      await expectRevert(legacy.connect(attacker).claimNfts([0, 1]), "NotBeneficiary()");
      // Any first-line beneficiary triggers; the payee is fixed by the item.
      const rc = await (await legacy.connect(bene2).claimNfts([0, 1])).wait();
      const activated = rc.events?.find((e: any) => e.event === "LegacyActivated");
      assert(activated, "review L-5: activation through an NFT claim is evented");
      assert.equal(activated.args.legacyId.toString(), legacyId.toString());
      assert.equal(await nft721.ownerOf(0), bene.address);
      assert.equal((await nft1155.balanceOf(bene2.address, 0)).toString(), "3");
      assert.equal((await nft1155.balanceOf(owner.address, 0)).toString(), "2");
      assert.equal(await legacy.isLive(), false);
      const [, moved] = await legacy.nftItem(1);
      assert.equal(moved.toString(), "3");
      await legacy.connect(bene).claimNfts([0, 1]); // no-op, nothing moves twice
      assert.equal((await nft1155.balanceOf(bene2.address, 0)).toString(), "3");
    });

    it("round 8: an owner contract cannot delete or edit the legacy from an NFT recipient's callback", async function () {
      const f = await loadFixture(fixture);
      const { dev, treasury, bene, router, verifierTerm, nft721 } = f;
      // Tx-based consent (a contract cannot sign the agreement message).
      await verifierTerm.connect(dev).setActiveTerms("2026-11", ethers.utils.id("terms 2026-11"));
      await verifierTerm.connect(dev).setConsentRecorder(router.address, true);
      const ownerC = await (await ethers.getContractFactory("MockContractOwner")).deploy();
      const heir = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
      const predicted: string = await router.getNextLegacyAddress(ownerC.address);
      const ts = (await ethers.provider.getBlock("latest")).timestamp;
      const create = router.interface.encodeFunctionData("createLegacyV2", [
        [
          { user: bene.address, percent: 500000 },
          { user: heir.address, percent: 500000 },
        ],
        { lackOfOutgoingTxRange: DAY, delayLayer2: 0, delayLayer3: 0 },
        { user: ZERO, percent: 0 },
        { user: ZERO, percent: 0 },
        { permitBatch: { details: [], spender: ZERO, sigDeadline: 0 }, signature: "0x" },
        ts,
        "0x",
      ]);
      await ownerC.exec(router.address, create);
      const legacy = await ethers.getContractAt("TransferEOALegacyV3", predicted);
      const legacyId = (await legacy.getLegacyInfo())[0];
      await nft721.mint(ownerC.address, 1); // id 2
      await ownerC.exec(nft721.address, nft721.interface.encodeFunctionData("setApprovalForAll", [legacy.address, true]));
      await ownerC.exec(legacy.address, legacy.interface.encodeFunctionData("setNftItems", [[item(nft721.address, ERC721, 2, 1, heir.address)]]));
      await treasury.sendTransaction({ to: legacy.address, value: ethers.utils.parseEther("1") });
      // On receiving the NFT, the heir has the owner contract delete the legacy (which would send it the ETH).
      const del = ownerC.interface.encodeFunctionData("exec", [router.address, router.interface.encodeFunctionData("deleteLegacy", [legacyId])]);
      await heir.arm(ownerC.address, del);
      await increase(DAY + 1);
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(2), heir.address, "the NFT moved");
      assert.equal((await heir.attempts()).toString(), "1");
      assert.equal((await heir.reentrySucceeded()).toString(), "0", "the delete from the callback was refused");
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), ethers.utils.parseEther("1").toString(), "the heirs' ETH stayed");
      assert.equal((await legacy.getIsActiveLegacy()).toString(), "2", "activated by the claim");
      assert.equal((await ownerC.received()).toString(), "0", "the owner contract got nothing");
    });

    it("round 8: an NFT claim that would activate the legacy but moves nothing reverts", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, nft721 } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, bene.address)]); // no approval given
      await increase(DAY + 1);
      await expectRevert(legacy.connect(bene).claimNfts([0]), "NothingClaimed()");
      assert.equal((await legacy.getIsActiveLegacy()).toString(), "1", "not activated");
    });

    it("an ERC-1155 claim in parts keeps the remainder; direct rail; failures skipped; delisted collection still claimable", async function () {
      const f = await loadFixture(fixture);
      const { owner, dev, bene, nftAllowlist, nft721, nft1155 } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setNftItems([
        item(nft721.address, ERC721, 1, 1, bene.address),
        item(nft1155.address, ERC1155, 0, 9, bene.address),
      ]);
      await nft1155.connect(owner).setApprovalForAll(legacy.address, true);
      await nftAllowlist.connect(dev).removeCollection(nft1155.address);
      await increase(DAY + 1);
      // The ERC-721 is not approved anywhere: skipped, the batch still lands.
      await legacy.connect(bene).claimNfts([0, 1]);
      assert.equal((await nft1155.balanceOf(bene.address, 0)).toString(), "5", "all the owner held");
      assert.equal((await legacy.nftItem(1))[1].toString(), "5", "4 still owed, not forfeited");
      assert.equal(await nft721.ownerOf(1), owner.address);
      // A later approval (an alive owner, say) lets the skipped item through.
      await nft721.connect(owner).setApprovalForAll(legacy.address, true);
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(1), bene.address);
    });

    it("an ERC-1155 remainder arriving later is paid on the next claim", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, nft1155, vault } = f;
      const { legacy } = await createV3(f, [{ user: bene.address, percent: 1000000 }]);
      await legacy.connect(owner).setNftItems([item(nft1155.address, ERC1155, 0, 7, bene.address)]);
      await nft1155.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);
      await legacy.connect(bene).claimNfts([0]);
      assert.equal((await nft1155.balanceOf(bene.address, 0)).toString(), "5");
      // Two more units of id 0 come back to the owner's wallet.
      await nft1155.connect(bene).safeTransferFrom(bene.address, owner.address, 0, 2, "0x");
      await legacy.connect(bene).claimNfts([0]);
      assert.equal((await legacy.nftItem(0))[1].toString(), "7");
    });

    it("a second-line beneficiary in its period takes every item", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, vault, nft721 } = f;
      const { legacy } = await createV3(f, [{ user: bene.address, percent: 1000000 }], {
        layer2: { user: bene3.address, percent: 1000000 },
        delayLayer2: 10 * DAY,
      });
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, bene.address)]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);
      await expectRevert(legacy.connect(bene3).claimNfts([0]), "NotBeneficiary()");
      await increase(10 * DAY);
      await legacy.connect(bene3).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene3.address);
    });
  });

  describe("per-beneficiary backup lines (running-total shares, review H-1)", function () {
    async function withLines() {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f));
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await usdc.connect(owner).approve(legacy.address, MAX);
      return { ...f, legacy, legacyId };
    }

    it("validation: Premium, delay bounds, first-line primaries, backups never the owner, a beneficiary, the executor or twice", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, other, premiumSetting, dev } = f;
      const { legacy } = await createV3(f, sixtyForty(f));
      const line = (o: any = {}) => ({ primary: bene.address, second: bene3.address, third: ZERO, ...o });
      await expectRevert(legacy.connect(owner).setBackupLines(29 * DAY, [line()]), "BackupDelayInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(3651 * DAY, [line()]), "BackupDelayInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(0, [line()]), "BackupDelayInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ primary: other.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: owner.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: bene2.address })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: ZERO })]), "BackupLineInvalid()");
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line(), line({ primary: bene2.address })]), "BackupLineInvalid()");
      await legacy.connect(owner).setExecutor(other.address);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line({ second: other.address })]), "BackupLineInvalid()");
      await premiumSetting.connect(dev).resetPremium(owner.address);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, [line()]), "NotPremium()");
    });

    it("out of order: B takes only B's share, A2 waits for the delay, then takes A's", async function () {
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
      // A's share is A2's now (round 7): A is refused; B gets nothing more.
      await expectRevert(router.connect(bene).activeLegacy(legacyId, [usdc.address], false), "ShareOwned(address)");
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "0");
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "399000000");
      assert.equal((await legacy.released(usdc.address, bene.address)).toString(), "600000000");
      assert.equal((await legacy.totalReleased(usdc.address)).toString(), "1000000000");
    });

    it("an inflow between claims is split by percentage: the later claimer does not take the earlier one's part", async function () {
      const { bene, bene2, router, legacyId, usdc, owner } = await withLines();
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A: 600 of 1,000
      await usdc.mint(owner.address, 100_000_000); // +100 before B claims
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      // B: 40% of 1,100 = 440 gross, not the 500 left in the wallet.
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "438900000");
      // A's 60 of the inflow waits for A, whenever A comes back.
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "60000000");
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), String(598500000 + 59850000));
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "0");
    });

    it("round 6: the wallet shrank after a claim: the next share gets what is there and the rest after an inflow", async function () {
      const { bene, bene2, attacker, router, legacy, legacyId, usdc, owner } = await withLines();
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A: 600 of 1,000
      await usdc.connect(owner).transfer(attacker.address, 300_000_000); // 100 left, pot 700
      // B is due 40% of 700 = 280; 100 is there. Before the fix nothing moved.
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "99750000", "100 gross, less the 25 bps fee");
      assert.equal((await legacy.released(usdc.address, bene2.address)).toString(), "100000000");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "0");
      await usdc.mint(owner.address, 500_000_000); // pot 1,200: B is due 480 - 100 = 380
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await legacy.released(usdc.address, bene2.address)).toString(), "480000000");
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), String(99750000 + 379050000));
      // A's 120 of the inflow is still A's.
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await legacy.released(usdc.address, bene.address)).toString(), "720000000");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "0");
    });

    it("round 6: the legacy's own guard: no token claim runs inside an NFT move, whatever the router", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, router, usdc, nft721 } = f;
      const heir = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
      const { legacy, legacyId } = await createV3(f, [
        { user: bene.address, percent: 500000 },
        { user: heir.address, percent: 500000 },
      ]);
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, heir.address)]);
      await nft721.connect(owner).setApprovalForAll(legacy.address, true);
      await usdc.connect(owner).approve(legacy.address, MAX);
      // On receiving the NFT the heir claims the tokens through the router.
      await heir.arm(router.address, router.interface.encodeFunctionData("activeLegacy", [legacyId, [usdc.address], false]));
      await increase(DAY + 1);
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), heir.address, "the NFT moved");
      assert.equal((await heir.attempts()).toString(), "1");
      assert.equal((await heir.reentrySucceeded()).toString(), "0", "the nested token claim was refused");
      assert.equal((await usdc.balanceOf(heir.address)).toString(), "0");
      // Outside the NFT move the token claim works as usual.
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(heir.address)).toString(), "498750000");
    });

    it("the unswap claim is refused in per-share mode; an ETH-only claim leaves the token shares untouched", async function () {
      const f = await withLines();
      const { owner, bene, bene2, router, legacy, legacyId, usdc, uni } = f;
      await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
      const now = await currentTime();
      await router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
      await owner.sendTransaction({ to: legacy.address, value: 1_000_000 });
      await increase(DAY + 1);
      // Two first-line shares: the router refuses first (review round 2).
      await expectRevert(router.connect(bene2).activeLegacyAndUnswap(legacyId, [], 1, now + 7200 + DAY), "UnswapNeedsSoleRecipient()");
      await router.connect(bene2).activeLegacy(legacyId, [], true); // ETH only
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      // A takes 60% of the token, B's 40% waits in the owner's wallet.
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "800000000");
    });

    it("a sole first-line share in per-share mode passes the router guard and is refused by the clone", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, router, usdc, uni } = f;
      const { legacy, legacyId } = await createV3(f, [{ user: bene.address, percent: 1000000 }]);
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
      const now = await currentTime();
      await router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 1);
      await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 1, now + 7200 + DAY), "UnswapNotInPerShareMode()");
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert((await usdc.balanceOf(bene.address)).gt(0));
    });

    it("the whole-estate second line settles every outstanding share; later inflows still split by percentage", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, other, router, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 1);
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false); // B: 400
      await increase(61 * DAY);
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false); // sweeps A's 600
      assert.equal((await usdc.balanceOf(other.address)).toString(), "598500000");
      assert.equal((await legacy.released(usdc.address, bene.address)).toString(), "600000000");
      await usdc.mint(owner.address, 100_000_000);
      await router.connect(bene2).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), String(399000000 + 39900000), "B's 40 of the inflow, no more");
    });

    it("round 3: the second line takes only shares whose own line never claimed; a claimed share's later inflows stay its line's", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, other, router, usdc, vault, nft721 } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await legacy.connect(owner).setNftItems([
        item(nft721.address, ERC721, 0, 1, bene.address),
        item(nft721.address, ERC721, 1, 1, bene2.address),
      ]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await usdc.connect(owner).approve(legacy.address, MAX);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A's line claims: 600
      assert.equal(await legacy.shareOwner(bene.address), bene.address);
      assert.equal(await legacy.shareOwner(bene2.address), ZERO);
      await usdc.mint(owner.address, 100_000_000); // deposit after A's claim

      await increase(61 * DAY);
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false);
      // Only B's due: 40% of 1,100 = 440 gross. A's 60 of the deposit stays A's.
      assert.equal((await usdc.balanceOf(other.address)).toString(), "438900000");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "60000000");
      assert.equal(await legacy.shareOwner(bene2.address), other.address, "the sweep owns the share it paid");
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "60000000", "a second sweep still leaves A's due");
      // NFTs follow the same rule: B's item to the second line, A's stays A's.
      await legacy.connect(other).claimNfts([0, 1]);
      assert.equal(await nft721.ownerOf(1), other.address);
      assert.equal(await nft721.ownerOf(0), owner.address);

      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), String(598500000 + 59850000));
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene.address);
    });

    it("round 7: a share belongs to the first address it pays: A's backup never takes A's later inflows or NFTs", async function () {
      const f = await withLines();
      const { owner, bene, bene3, router, legacy, legacyId, usdc, vault, nft721 } = f;
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, bene.address)]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A: 600
      await usdc.mint(owner.address, 100_000_000);
      await increase(31 * DAY); // A2's window is open
      await expectRevert(router.connect(bene3).activeLegacy(legacyId, [usdc.address], false), "ShareOwned(address)");
      await expectRevert(router.connect(bene3).activeLegacy(legacyId, [], true), "ShareOwned(address)");
      await legacy.connect(bene3).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), owner.address, "A's NFT does not go to A2");
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A's 60 of the inflow
      assert.equal((await legacy.released(usdc.address, bene.address)).toString(), "660000000");
      await legacy.connect(bene).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene.address);
    });

    it("round 7: whoever of the line is paid first owns the share; an empty claim owns nothing", async function () {
      const { bene, bene3, router, legacy, legacyId, usdc } = await withLines();
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [], true); // nothing to pay
      assert.equal(await legacy.shareOwner(bene.address), ZERO, "an empty claim takes no ownership");
      await increase(30 * DAY);
      await router.connect(bene3).activeLegacy(legacyId, [usdc.address], false); // A2 is paid A's 600
      assert.equal(await legacy.shareOwner(bene.address), bene3.address);
      await expectRevert(router.connect(bene).activeLegacy(legacyId, [usdc.address], false), "ShareOwned(address)");
    });

    it("round 7: after the second line swept a share, its own line cannot come back, not even with an empty claim", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, other, router, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await legacy.connect(owner).setBackupLines(30 * DAY, []);
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // A: 600
      await increase(61 * DAY);
      // B's empty claim before the sweep takes nothing and owns nothing.
      await router.connect(bene2).activeLegacy(legacyId, [], true);
      assert.equal(await legacy.shareOwner(bene2.address), ZERO);
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false); // sweeps B's 400
      assert.equal(await legacy.shareOwner(bene2.address), other.address);
      await usdc.mint(owner.address, 100_000_000);
      await expectRevert(router.connect(bene2).activeLegacy(legacyId, [usdc.address], false), "ShareOwned(address)");
      await expectRevert(router.connect(bene2).activeLegacy(legacyId, [], true), "ShareOwned(address)");
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false); // B's 40 of the inflow
      assert.equal((await legacy.released(usdc.address, bene2.address)).toString(), "440000000");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "60000000", "A's 60 stays A's");
    });

    async function withLayers() {
      const f = await loadFixture(fixture);
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: f.other.address, percent: 1000000 },
        layer3: { user: f.bene3.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
        delayLayer3: 60 * DAY,
      });
      return { ...f, legacy, legacyId };
    }
    const full = (user: string) => ({ user, percent: 1000000 });
    const layersOf = async (legacy: any) => {
      const [, l2, l3] = await legacy.getLegacyBeneficiaries();
      return [l2, l3];
    };
    // setLegacyConfig: the current second line moves to the first line and a new second line is named, in one transaction.
    const moveSecondIntoFirst = (f: any, legacyId: any) =>
      f.router.connect(f.owner).setLegacyConfig(
        legacyId,
        { name: "", note: "", nickNames: ["", ""], distributions: [{ user: f.bene.address, percent: 500000 }, { user: f.other.address, percent: 500000 }] },
        { lackOfOutgoingTxRange: DAY, delayLayer2: 60 * DAY, delayLayer3: 60 * DAY },
        full(f.safe.address),
        full(f.bene3.address),
        "",
        ""
      );

    it("round 8: the router's combined setters pass through transient states in whole-estate mode", async function () {
      const f = await withLayers();
      const { owner, other, bene3, safe, router, legacy, legacyId } = f;
      // Second and third lines swapped: l2 == l3 between the two child calls.
      await router.connect(owner).setBothLayer23Distributions(legacyId, "", full(bene3.address), "", full(other.address));
      assert.deepEqual(await layersOf(legacy), [bene3.address, other.address]);
      await router.connect(owner).setBothLayer23Distributions(legacyId, "", full(other.address), "", full(bene3.address));
      // The second line moves into the first line while a new second line is named.
      await moveSecondIntoFirst(f, legacyId);
      assert.deepEqual(await layersOf(legacy), [safe.address, bene3.address]);
      assert.equal(await legacy.getBeneficiaryLayer(other.address), 1);
    });

    it("round 8: in per-share mode the swap keeps the lines; the cross-line move leaves per-share mode", async function () {
      const f = await withLayers();
      const { owner, bene, other, bene2, bene3, safe, router, legacy, legacyId } = f;
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: f.attacker.address, third: ZERO }]);
      await router.connect(owner).setBothLayer23Distributions(legacyId, "", full(bene3.address), "", full(other.address));
      assert.deepEqual(await layersOf(legacy), [bene3.address, other.address]);
      assert.equal((await legacy.backupDelay()).toString(), String(30 * DAY), "still per-share");
      await router.connect(owner).setBothLayer23Distributions(legacyId, "", full(other.address), "", full(bene3.address));
      await moveSecondIntoFirst(f, legacyId);
      assert.deepEqual(await layersOf(legacy), [safe.address, bene3.address]);
      assert.equal((await legacy.backupDelay()).toString(), "0", "a first-line edit leaves per-share mode");
      assert.equal((await legacy.getBackupLine(bene.address))[0], ZERO);
    });

    it("round 8: per-share mode is refused for configurations that strand funds; the second line equal to the third is allowed", async function () {
      const f = await withLayers();
      const { owner, bene, bene2, bene3, other, attacker, router, legacy, legacyId, usdc } = f;
      const line = [{ primary: bene.address, second: attacker.address, third: ZERO }];
      // Whole-estate mode accepts a first line that names the second line (as wave A does)...
      await router.connect(owner).setLegacyDistributions(legacyId, ["", ""], [{ user: bene.address, percent: 500000 }, { user: other.address, percent: 500000 }]);
      // ...but such an address counts as first line and could never sweep: per-share mode is refused.
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, line), "FirstLineInvalid()");
      await router.connect(owner).setLegacyDistributions(legacyId, ["", ""], [{ user: bene.address, percent: 500000 }, { user: bene3.address, percent: 500000 }]);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, line), "FirstLineInvalid()");
      // A repeated address sums below 100%: accepted whole-estate, refused per-share.
      await router.connect(owner).setLegacyDistributions(legacyId, ["", "", ""], [
        { user: bene.address, percent: 300000 },
        { user: bene2.address, percent: 400000 },
        { user: bene.address, percent: 300000 },
      ]);
      await expectRevert(legacy.connect(owner).setBackupLines(30 * DAY, line), "FirstLineInvalid()");
      await router.connect(owner).setLegacyDistributions(legacyId, ["", ""], sixtyForty(f));
      await legacy.connect(owner).setBackupLines(30 * DAY, line);
      // In per-share mode a layer edit onto a first-line address is refused (wave A's own check).
      await expectRevert(router.connect(owner).setLayer23Distributions(legacyId, 2, "", full(bene.address)), "AlreadyBeneficiary()");
      // The second line equal to the third strands nothing: one address covers both periods.
      await router.connect(owner).setLayer23Distributions(legacyId, 2, "", full(bene3.address));
      assert.deepEqual(await layersOf(legacy), [bene3.address, bene3.address]);
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 121 * DAY); // the third line's period
      await router.connect(bene3).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene3.address)).toString(), "997500000", "it sweeps every unowned share");
    });

    it("round 7: a legacy created with a repeated first-line address cannot turn on per-share mode; whole-estate claims still pay everything", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, bene3, router, usdc } = f;
      const { legacy, legacyId } = await createV3(f, [
        { user: bene.address, percent: 300000 },
        { user: bene2.address, percent: 400000 },
        { user: bene.address, percent: 300000 },
      ]);
      await expectRevert(
        legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]),
        "FirstLineInvalid()"
      );
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "0", "as on wave A, the last beneficiary takes the remainder");
    });

    it("round 3: without backup lines the whole-estate second line is unchanged (it takes everything pullable)", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, other, router, usdc } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await usdc.connect(owner).approve(legacy.address, MAX);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false); // one claim pays both
      assert.equal((await usdc.balanceOf(bene2.address)).toString(), "399000000");
      await usdc.mint(owner.address, 100_000_000);
      await increase(61 * DAY);
      await router.connect(other).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(other.address)).toString(), "99750000");
      assert.equal((await usdc.balanceOf(owner.address)).toString(), "0");
    });

    it("ETH shares work the same way", async function () {
      const { owner, bene2, bene3, router, legacy, legacyId } = await withLines();
      await owner.sendTransaction({ to: legacy.address, value: 1_000_000_000 });
      await increase(DAY + 1);
      const before = await ethers.provider.getBalance(legacy.address);
      await router.connect(bene2).activeLegacy(legacyId, [], true);
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), before.sub(400_000_000).toString());
      await increase(30 * DAY);
      await router.connect(bene3).activeLegacy(legacyId, [], true);
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), "0");
    });

    it("review L-3: a backup can never become a second- or third-line beneficiary", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, other, router } = f;
      const { legacy, legacyId } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
      await expectRevert(
        router.connect(owner).setLayer23Distributions(legacyId, 2, "", { user: bene3.address, percent: 1000000 }),
        "BackupLineInvalid()"
      );
    });

    it("review L-4: backups must open before the second line (delayLayer2 >= 2 x backupDelay)", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene3, other } = f;
      const { legacy } = await createV3(f, sixtyForty(f), {
        layer2: { user: other.address, percent: 1000000 },
        delayLayer2: 60 * DAY,
      });
      const line = [{ primary: bene.address, second: bene3.address, third: ZERO }];
      await expectRevert(legacy.connect(owner).setBackupLines(31 * DAY, line), "BackupDelayInvalid()");
      await legacy.connect(owner).setBackupLines(30 * DAY, line);
    });

    it("changing the first line voids the lines and the NFT items, with their events", async function () {
      const { owner, bene, bene3, router, legacy, legacyId, nft721 } = await withLines();
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, bene.address)]);
      const rc = await (
        await router.connect(owner).setLegacyDistributions(legacyId, [""], [{ user: bene.address, percent: 1000000 }])
      ).wait();
      const names = rc.logs
        .filter((l: any) => l.address === legacy.address)
        .map((l: any) => legacy.interface.parseLog(l))
        .map((p: any) => `${p.name}:${p.args[1]}`);
      assert(names.includes("BackupLinesSet:0") && names.includes("NftItemsSet:0"), `got ${names}`);
      assert.equal((await legacy.backupDelay()).toString(), "0");
      assert.equal(await legacy.getBeneficiaryLayer(bene3.address), 0);
      await expectRevert(legacy.nftItem(0), "Panic(uint256)"); // no items in the new epoch
    });

    it("review L-2: a backup's NFT claim before its window moves nothing and does not activate the legacy", async function () {
      const { owner, bene, bene3, legacy, vault, nft721 } = await withLines();
      await legacy.connect(owner).setNftItems([item(nft721.address, ERC721, 0, 1, bene.address)]);
      await nft721.connect(owner).setApprovalForAll(vault.address, true);
      await increase(DAY + 1);
      await expectRevert(legacy.connect(bene3).claimNfts([0]), "NothingClaimed()"); // round 8: reverts instead of a no-op
      assert.equal((await legacy.getIsActiveLegacy()).toString(), "1", "still not activated");
      assert.equal(await nft721.ownerOf(0), owner.address);
      await increase(30 * DAY);
      await legacy.connect(bene3).claimNfts([0]);
      assert.equal(await nft721.ownerOf(0), bene3.address);
      assert.equal((await legacy.getIsActiveLegacy()).toString(), "2");
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

    it("Premium to name; never the owner or a beneficiary, now or later; removal always allowed", async function () {
      const f = await loadFixture(fixture);
      const { owner, dev, bene, other, router, premiumSetting } = f;
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
      await premiumSetting.connect(dev).resetPremium(owner.address);
      await expectRevert(legacy.connect(owner).setExecutor(other.address), "NotPremium()");
      await legacy.connect(owner).setExecutor(ZERO);
    });

    it("review L-1: no attestation before the owner has been silent for half the trigger", async function () {
      const { legacy, executor, bene } = await withExecutor();
      await expectRevert(legacy.connect(bene).attestDeath(), "NotExecutor()");
      await increase(180 * DAY);
      await expectRevert(legacy.connect(executor).attestDeath(), "AttestationNotAllowed()");
      await increase(3 * DAY);
      await legacy.connect(executor).attestDeath();
    });

    it("an attestation brings claims forward to 30 days, and the executor receives nothing", async function () {
      const { bene, router, legacy, legacyId, executor, usdc } = await withExecutor();
      await increase(183 * DAY);
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

    it("any owner check-in during the grace period cancels the attestation; at most one per grace period", async function () {
      const { owner, bene, router, legacy, legacyId, executor, usdc } = await withExecutor();
      await increase(183 * DAY);
      await legacy.connect(executor).attestDeath();
      await increase(10 * DAY);
      await router.connect(owner).avtiveAlive(legacyId);
      await expectRevert(legacy.connect(executor).attestDeath(), "AttestationNotAllowed()");
      await increase(21 * DAY);
      await expectRevert(router.connect(bene).activeLegacy(legacyId, [usdc.address], false), "NotEnoughContitionalActive()");
    });

    it("the dead-owner test: without the executor, claims open at the normal deadline", async function () {
      const { bene, router, legacyId, usdc } = await withExecutor();
      await increase(365 * DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert.equal((await usdc.balanceOf(bene.address)).toString(), "997500000");
    });

    it("no attestation on a deleted legacy; removing the executor clears one", async function () {
      const { owner, router, legacy, legacyId, executor } = await withExecutor();
      await increase(183 * DAY);
      await legacy.connect(executor).attestDeath();
      await legacy.connect(owner).setExecutor(ZERO);
      assert.equal((await legacy.deathAttestedAt()).toString(), "0");
      await expectRevert(legacy.connect(executor).attestDeath(), "NotExecutor()");
      await legacy.connect(owner).setExecutor(executor.address);
      await router.connect(owner).deleteLegacy(legacyId);
      await expectRevert(legacy.connect(executor).attestDeath(), "AttestationNotAllowed()");
    });
  });

  describe("gas", function () {
    it("a 10-token claim: wave A clone (two beneficiaries) and v3 per-share", async function () {
      const ERC20 = await ethers.getContractFactory("ERC20Token");
      const measure = async (f: any, contractName: string, perShare: boolean) => {
        const { owner, bene, bene3, router } = f;
        const tokens: any[] = [];
        for (let i = 0; i < 10; i++) {
          const t = await ERC20.deploy(`T${i}`, `T${i}`, 18);
          await t.mint(owner.address, ethers.utils.parseEther("100"));
          tokens.push(t);
        }
        const { legacy, legacyId } = await createLegacyV2(router, owner, sixtyForty(f), { contractName });
        if (perShare) await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
        for (const t of tokens) await t.connect(owner).approve(legacy.address, MAX);
        await increase(DAY + 1);
        const rc = await (await router.connect(bene).activeLegacy(legacyId, tokens.map((t) => t.address), false)).wait();
        return rc.gasUsed.toNumber();
      };
      const a = await measure(await deployTrain(), "TransferEOALegacy", false);
      const b = await measure(await deployTrain(v3Options), "TransferEOALegacyV3", true);
      console.log(`      gas, 10-token claim: wave A clone ${a} (pays both beneficiaries), v3 per-share ${b} (pays one share)`);
      assert(a < 3_000_000 && b < 3_000_000);
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
