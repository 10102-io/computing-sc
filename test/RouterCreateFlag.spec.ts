import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert, EMPTY_BUNDLE, ZERO_DIST } from "./fixtures/eoaTrain";

// The router's create flag (`isCreateLegacy[owner]`, one live wallet legacy
// per owner) and what may release it (checklist audit RC-L, found
// 2026-11-11): only the claim that ends a legacy, never a later claim on
// it, and `releaseCreateFlag` only while the vault holds no live legacy for
// the owner. Before, every claim cleared the flag, also when the owner had
// created the next legacy in between.

const ERC721 = 1;
const ZERO = ethers.constants.AddressZero;
const CLAIM_TYPES = {
  ClaimAuth: [
    { name: "beneficiary", type: "address" },
    { name: "legacyId", type: "uint256" },
    { name: "assetsHash", type: "bytes32" },
    { name: "isETH", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};
/** The three ways a claim reaches the router. */
const CLAIMS = ["a plain claim", "a relayed claim", "an unswap claim"] as const;
type Claim = (typeof CLAIMS)[number];

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

  /** An ETH claim by `bene` on `legacyId`, sent in one of the three ways. */
  async function claim(f: any, how: Claim, bene: any, legacyId: any) {
    const { router, other } = f;
    const deadline = (await currentTime()) + 3600;
    if (how === "a plain claim") return router.connect(bene).activeLegacy(legacyId, [], true);
    if (how === "an unswap claim") return router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, deadline);
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "10102 Legacy Sponsored", version: "1", chainId, verifyingContract: router.address };
    const nonce = await router.sponsorNonce(bene.address);
    const value = {
      beneficiary: bene.address,
      legacyId,
      assetsHash: ethers.utils.solidityKeccak256(["address[]"], [[]]),
      isETH: true,
      nonce,
      deadline,
    };
    const signature = await bene._signTypedData(domain, CLAIM_TYPES, value);
    return router.connect(other).activeLegacyFor(legacyId, [], true, { beneficiary: bene.address, nonce, deadline, signature });
  }

  /** Legacy A is claimed (and so ended) by `bene`; the owner then creates legacy B. */
  async function endedThenRecreated(f: any, ending: Claim = "a plain claim") {
    const { owner, bene, bene2, other, router } = f;
    const a = await createLegacyV2(router, owner, halves(bene, bene2));
    await increase(DAY + 1);
    await claim(f, ending, bene, a.legacyId);
    assert.equal(await a.legacy.isLive(), false);
    assert.equal(await router.isCreateLegacy(owner.address), false, "the claim that ends A releases the owner");
    const b = await createLegacyV2(router, owner, all(other));
    assert.equal(await router.isCreateLegacy(owner.address), true);
    return { a, b };
  }

  describe("claims", function () {
    for (const ending of CLAIMS) {
      for (const later of CLAIMS) {
        it(`${ending} ends a legacy and releases its owner; ${later} on it afterwards leaves the flag of the owner's next legacy`, async function () {
          const f = await loadFixture(fixture);
          const { owner, bene2, router, vault } = f;
          const { a, b } = await endedThenRecreated(f, ending);
          assert.equal(await vault.boundLegacy(owner.address), b.legacy.address);
          await claim(f, later, bene2, a.legacyId);
          assert.equal(await router.isCreateLegacy(owner.address), true);
          assert.equal(await b.legacy.isLive(), true);
        });
      }
    }

    it("a later token claim still pays, the router refuses a second live legacy, and the next legacy ends like any other", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, other, router, usdt } = f;
      const { a, b } = await endedThenRecreated(f);

      // A token the owner approved to A directly: an ordinary later claim.
      await usdt.connect(owner).approve(a.legacy.address, 400_000_000);
      const before = await usdt.balanceOf(bene.address);
      await router.connect(bene).activeLegacy(a.legacyId, [usdt.address], false);
      assert((await usdt.balanceOf(bene.address)).gt(before), "the later claim itself still pays");
      assert.equal(await router.isCreateLegacy(owner.address), true);

      // The router itself refuses the next create now, not only the vault.
      const extra = { lackOfOutgoingTxRange: DAY, delayLayer2: 0, delayLayer3: 0 };
      await expectRevert(
        router.connect(owner).createLegacyV2(all(other), extra, ZERO_DIST, ZERO_DIST, EMPTY_BUNDLE, await currentTime(), "0x"),
        "SenderIsCreatedLegacy(address)"
      );

      // B is untouched and ends like any legacy: its claim releases the owner.
      assert.equal(await b.legacy.isLive(), true);
      await increase(DAY + 1);
      await router.connect(other).activeLegacy(b.legacyId, [], true);
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });

    it("a second-line claim that ends the legacy releases the owner too", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, other, router } = f;
      const a = await createLegacyV2(router, owner, all(bene), { layer2: { user: bene2.address, percent: 1000000 }, delayLayer2: DAY });
      await increase(2 * DAY + 2);
      await router.connect(bene2).activeLegacy(a.legacyId, [], true);
      assert.equal(await a.legacy.isLive(), false);
      assert.equal(await router.isCreateLegacy(owner.address), false);

      await createLegacyV2(router, owner, all(other));
      await router.connect(bene2).activeLegacy(a.legacyId, [], true);
      assert.equal(await router.isCreateLegacy(owner.address), true);
    });

    it("a claim that fails releases nothing", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, attacker, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await expectRevert(router.connect(bene).activeLegacy(a.legacyId, [], true), "NotEnoughContitionalActive()");
      await increase(DAY + 1);
      await expectRevert(router.connect(attacker).activeLegacy(a.legacyId, [], true), "OnlyBeneficaries()");
      await expectRevert(router.connect(bene).activeLegacy(a.legacyId, [], false), "NumAssetsInvalid()");
      assert.equal(await a.legacy.isLive(), true);
      assert.equal(await router.isCreateLegacy(owner.address), true);
    });

    it("an owner contract that creates its next legacy while the ending claim pays out keeps that legacy's flag", async function () {
      const f = await loadFixture(fixture);
      const { dev, treasury, bene, other, router, vault, verifierTerm } = f;
      // Consent by transaction: a contract cannot sign the agreement message.
      await verifierTerm.connect(dev).setActiveTerms("2026-11", ethers.utils.id("terms 2026-11"));
      await verifierTerm.connect(dev).setConsentRecorder(router.address, true);
      const ownerC = await (await ethers.getContractFactory("MockContractOwner")).deploy();
      const heir = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
      const extra = { lackOfOutgoingTxRange: DAY, delayLayer2: 0, delayLayer3: 0 };
      const create = async (dist: any[]) =>
        router.interface.encodeFunctionData("createLegacyV2", [dist, extra, ZERO_DIST, ZERO_DIST, EMPTY_BUNDLE, await currentTime(), "0x"]);

      const aAddress: string = await router.getNextLegacyAddress(ownerC.address);
      await ownerC.exec(router.address, await create(halves(bene, heir)));
      const a = await ethers.getContractAt("TransferEOALegacy", aAddress);
      const aId = (await a.getLegacyInfo())[0];
      await treasury.sendTransaction({ to: aAddress, value: ethers.utils.parseEther("1") });
      await increase(DAY + 1);

      // On receiving its share, the heir has the owner contract create legacy B.
      const bAddress: string = await router.getNextLegacyAddress(ownerC.address);
      await heir.arm(ownerC.address, ownerC.interface.encodeFunctionData("exec", [router.address, await create(all(other))]));
      await router.connect(bene).activeLegacy(aId, [], true);

      assert.equal((await heir.reentrySucceeded()).toString(), "1", "B was created inside A's claim");
      const b = await ethers.getContractAt("TransferEOALegacy", bAddress);
      assert.equal(await a.isLive(), false);
      assert.equal(await b.isLive(), true);
      assert.equal(await vault.boundLegacy(ownerC.address), bAddress);
      assert.equal(await router.isCreateLegacy(ownerC.address), true, "the flag is B's: the claim released A's before it paid out");
    });

    for (const [answer, name, releases] of [
      [0, "reverts", true],
      [1, "returns nothing", true],
      [2, "returns a word that is no bool", true],
      [3, "returns false", false],
    ] as const) {
      it(`a legacy whose isLive() ${name} is claimed all the same, and ${releases ? "releases as before" : "releases nothing"}`, async function () {
        const f = await loadFixture(fixture);
        const { owner, bene, router } = f;
        const a = await createLegacyV2(router, owner, all(bene));
        const mock = await (await ethers.getContractFactory("MockLegacyOddIsLive")).deploy(owner.address, answer);
        await ethers.provider.send("hardhat_setCode", [a.legacy.address, await ethers.provider.getCode(mock.address)]);
        const planted = await ethers.getContractAt("MockLegacyOddIsLive", a.legacy.address);

        for (const how of CLAIMS) {
          await ethers.provider.send("hardhat_setStorageAt", [
            router.address,
            ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(["address", "uint256"], [owner.address, 3])),
            ethers.utils.hexZeroPad("0x01", 32),
          ]);
          assert.equal(await router.isCreateLegacy(owner.address), true, "the flag is the mapping at slot 3");
          const rc = await (await claim(f, how, bene, a.legacyId)).wait();
          const claimed = rc.logs.filter((l: any) => l.address === a.legacy.address).map((l: any) => planted.interface.parseLog(l));
          assert.equal(claimed.length, 1, `${how} reached the legacy`);
          assert.equal(claimed[0].args.beneficiary, bene.address);
          assert.equal(await router.isCreateLegacy(owner.address), !releases, how);
        }
      });
    }
  });

  describe("releaseCreateFlag", function () {
    it("owner only, never on a live legacy, repeatable on an ended one", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, attacker, router } = f;
      const a = await createLegacyV2(router, owner, all(bene));
      await expectRevert(router.connect(attacker).releaseCreateFlag(a.legacyId), "OnlyOwner()");
      await expectRevert(router.connect(owner).releaseCreateFlag(a.legacyId), "LegacyStillActive()");
      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(a.legacyId, [], true);
      await expectRevert(router.connect(bene).releaseCreateFlag(a.legacyId), "OnlyOwner()");

      for (let i = 0; i < 2; i++) {
        const rc = await (await router.connect(owner).releaseCreateFlag(a.legacyId)).wait();
        const ev = rc.events?.find((e: any) => e.event === "TransferEOALegacyCreateFlagReleased");
        assert(ev && ev.args!.owner === owner.address && ev.args!.legacyId.eq(a.legacyId));
        assert.equal(await router.isCreateLegacy(owner.address), false);
      }
    });

    it("refused while the vault holds a live legacy for the owner: an ended legacy cannot release the next one's flag", async function () {
      const f = await loadFixture(fixture);
      const { owner, other, router } = f;
      const { a, b } = await endedThenRecreated(f);
      await expectRevert(router.connect(owner).releaseCreateFlag(a.legacyId), "LegacyStillActive()");
      assert.equal(await router.isCreateLegacy(owner.address), true);

      // Once B has ended too, either id releases (the flag is false by then).
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

      await expectRevert(router.connect(owner).deleteLegacy(a.legacyId), "LegacyIsDeleted()");
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
      await router.connect(timelock).setPullVault(ZERO);
      await router.connect(owner).releaseCreateFlag(a.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
    });

    it("only the router's current vault is asked: a live legacy bound in an earlier vault is not seen", async function () {
      const f = await loadFixture(fixture);
      const { owner, router, timelock, impl, vault } = f;
      const { a, b } = await endedThenRecreated(f);
      const next = await (await ethers.getContractFactory("LegacyPullVaultV2")).deploy(router.address, timelock.address, impl.address);
      await router.connect(timelock).setPullVault(next.address);
      assert.equal(await vault.boundLegacy(owner.address), b.legacy.address);
      assert.equal(await next.boundLegacy(owner.address), ZERO);

      // The documented limit of the check (as before this check existed, for every release).
      await router.connect(owner).releaseCreateFlag(a.legacyId);
      assert.equal(await router.isCreateLegacy(owner.address), false);
      assert.equal(await b.legacy.isLive(), true);
    });
  });
});
