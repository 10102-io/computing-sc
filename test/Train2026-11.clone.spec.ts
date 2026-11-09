import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert, revertedWith } from "./fixtures/eoaTrain";

// Wave A clone implementation (docs/plans/train-2026-11.md): checklist audit
// M-2 (SafeERC20 on the direct ERC-20 rail), M-4 (zero-minimum unswap),
// DEFERRED eoa-unswap-weth and legacy-claim-fee-cap. New legacies only.

describe("Train 2026-11 — wave A clone (TransferEOALegacy)", function () {
  this.timeout(200000);

  const fixture = async () => deployTrain();
  const fixture51 = async () => deployTrain({ feeBps: 51 });
  const fixture50 = async () => deployTrain({ feeBps: 50 });

  const ONE = 1_000_000_000; // 1,000 tokens at 6 decimals

  describe("M-2: direct ERC-20 rail", function () {
    it("the old rail reverts on a no-return token (the bug every live clone has)", async function () {
      const { owner, bene, usdt } = await loadFixture(fixture);
      const old = await (await ethers.getContractFactory("MockOldDirectRail")).deploy();
      await usdt.connect(owner).approve(old.address, ONE);
      let caught: any;
      try {
        await old.pull(usdt.address, owner.address, bene.address, ONE);
      } catch (e) {
        caught = e;
      }
      assert(caught, "a bare try/transferFrom must revert on a token that returns nothing");
    });

    it("a direct USDT allowance pays out on the claim path, fee included, next to a normal token", async function () {
      const { owner, bene, bene2, router, usdt, usdc, payment, feeBps } = await loadFixture(fixture);
      const { legacy, legacyId } = await createLegacyV2(router, owner, [
        { user: bene.address, percent: 600000 },
        { user: bene2.address, percent: 400000 },
      ]);
      await usdt.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      await usdc.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      const paymentEthBefore = await ethers.provider.getBalance(payment.address);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [usdt.address, usdc.address], false);

      const fee = Math.floor((ONE * feeBps) / 10_000);
      const net = ONE - fee;
      assert.equal((await usdt.balanceOf(bene.address)).toString(), String(Math.floor((net * 6) / 10)));
      assert.equal((await usdt.balanceOf(bene2.address)).toString(), String(net - Math.floor((net * 6) / 10)));
      assert.equal((await usdt.balanceOf(owner.address)).toString(), "0");
      assert.equal((await usdc.balanceOf(bene.address)).toString(), String(Math.floor((net * 6) / 10)));
      // Both fees reach Payment as the tokens themselves, never swapped.
      assert.equal((await usdt.balanceOf(payment.address)).toString(), String(fee));
      assert.equal((await usdc.balanceOf(payment.address)).toString(), String(fee));
      assert.equal((await usdt.balanceOf(legacy.address)).toString(), "0");
      assert((await ethers.provider.getBalance(payment.address)).eq(paymentEthBefore), "no fee swapped to ETH");
    });

    it("a token that returns false moves nothing, counts as failed, and never bricks the batch", async function () {
      const { owner, bene, router, usdc, falseToken } = await loadFixture(fixture);
      const { legacy, legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      await falseToken.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      await usdc.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      await falseToken.setFailTransfers(true);
      const ownerFalseBefore = await falseToken.balanceOf(owner.address);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [falseToken.address, usdc.address], false);

      assert.equal((await falseToken.balanceOf(bene.address)).toString(), "0");
      assert.equal((await falseToken.balanceOf(owner.address)).toString(), ownerFalseBefore.toString());
      assert((await usdc.balanceOf(bene.address)).gt(0), "the other token still distributes");

      // Once the token behaves again, a later tranche pulls it (multi-tranche claims are unchanged).
      await falseToken.setFailTransfers(false);
      await router.connect(bene).activeLegacy(legacyId, [falseToken.address], false);
      assert((await falseToken.balanceOf(bene.address)).gt(0));
    });
  });

  describe("M-4 and eoa-unswap-weth: swaps", function () {
    async function withStorageToken(token: "usdc" | "weth") {
      const f = await loadFixture(fixture);
      const { owner, bene, router, usdc, weth, uni } = f;
      const { legacy, legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      const storageToken = token === "usdc" ? usdc.address : weth.address;
      if (token === "usdc") await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
      const now = await currentTime();
      // 1e9 wei through the mock = 1e9 token units (1,000 USDC); WETH wraps 1:1.
      await router
        .connect(owner)
        .autoSwap(legacyId, { storageToken, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
      assert.equal(await legacy.eoaStorageToken(), storageToken);
      const storage = token === "usdc" ? usdc : weth;
      await storage.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      return { ...f, legacy, legacyId, storage };
    }

    it("router autoSwap: a non-WETH swap with a zero minimum reverts for every legacy; WETH needs none", async function () {
      const { owner, bene, router, usdc, weth } = await loadFixture(fixture);
      const { legacyId } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      const now = await currentTime();
      await expectRevert(
        router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 0, deadline: now + 3600 }, { value: 1000 }),
        "ZeroAmountOutMin()"
      );
      await router.connect(owner).autoSwap(legacyId, { storageToken: weth.address, amountOutMin: 0, deadline: now + 3600 }, { value: 1000 });
    });

    it("claim with unswap: a non-WETH storage token and a zero minimum reverts (the sandwich M-4 closes)", async function () {
      const { bene, router, legacyId } = await withStorageToken("usdc");
      await increase(DAY + 1);
      const now = await currentTime();
      await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, now + 3600), "ZeroAmountOutMin()");
    });

    it("claim with unswap: a quoted minimum swaps and pays ETH; the no-swap claim still works with nothing to swap", async function () {
      const { bene, router, legacyId, legacy } = await withStorageToken("usdc");
      await increase(DAY + 1);
      const now = await currentTime();
      const before = await ethers.provider.getBalance(bene.address);
      const tx = await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 900_000_000, now + 3600);
      const rc = await tx.wait();
      const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
      const received = (await ethers.provider.getBalance(bene.address)).sub(before).add(gas);
      assert(received.gt(0), "beneficiary received the swapped ETH");
      assert.equal(await legacy.eoaStorageToken(), ethers.constants.AddressZero);
      // Nothing left to pull: a zero minimum is fine because no swap runs.
      await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, now + 3600);
    });

    it("claim with unswap (review L-3): with co-recipients a non-WETH swap reverts; they claim the token instead", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, router, usdc, uni } = f;
      const { legacy, legacyId } = await createLegacyV2(router, owner, [
        { user: bene.address, percent: 500000 },
        { user: bene2.address, percent: 500000 },
      ]);
      await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
      const now = await currentTime();
      await router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
      await usdc.connect(owner).approve(legacy.address, ethers.constants.MaxUint256);
      await increase(DAY + 1);
      // A co-beneficiary would pick the minimum for everyone's share: refused.
      await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 1, now + 7200), "UnswapNeedsSoleRecipient()");
      await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
      assert((await usdc.balanceOf(bene2.address)).gt(0), "each co-recipient gets the token itself");
    });

    it("claim with unswap: with only a vault approval nothing converts, so co-recipients pass with a zero minimum and get the token", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, router, usdc, uni, permit2, vault } = f;
      const { legacy, legacyId } = await createLegacyV2(router, owner, [
        { user: bene.address, percent: 500000 },
        { user: bene2.address, percent: 500000 },
      ]);
      await usdc.mint(uni.address, ethers.utils.parseUnits("1000000", 6));
      const now = await currentTime();
      await router.connect(owner).autoSwap(legacyId, { storageToken: usdc.address, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
      await usdc.connect(owner).approve(permit2.address, ethers.constants.MaxUint256);
      await permit2.connect(owner).approve(usdc.address, vault.address, ethers.BigNumber.from(2).pow(160).sub(1), now + 365 * DAY);
      const uniUsdc = await usdc.balanceOf(uni.address);
      await increase(DAY + 1);
      await router.connect(bene).activeLegacyAndUnswap(legacyId, [usdc.address], 0, now + 7200 + DAY);
      assert.equal(await legacy.eoaStorageToken(), ethers.constants.AddressZero);
      assert((await usdc.balanceOf(uni.address)).eq(uniUsdc), "nothing swapped");
      assert((await usdc.balanceOf(bene.address)).gt(0) && (await usdc.balanceOf(bene2.address)).gt(0), "both receive the token");
    });

    it("claim with unswap: WETH unwraps 1:1 and needs no minimum", async function () {
      const { bene, router, legacyId, uni } = await withStorageToken("weth");
      const uniEth = await ethers.provider.getBalance(uni.address);
      await increase(DAY + 1);
      const now = await currentTime();
      await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, now + 3600);
      assert.equal((await ethers.provider.getBalance(uni.address)).toString(), uniEth.toString(), "Uniswap untouched");
    });

    it("owner unswap of a WETH storage token unwraps and pays ETH (reverted with IDENTICAL_ADDRESSES before)", async function () {
      const { owner, router, legacyId, legacy, weth, uni } = await withStorageToken("weth");
      const uniEth = await ethers.provider.getBalance(uni.address);
      const before = await ethers.provider.getBalance(owner.address);
      const now = await currentTime();
      const tx = await router.connect(owner).unswap(legacyId, 1_000_000_000, 0, now + 3600);
      const rc = await tx.wait();
      const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
      assert.equal((await ethers.provider.getBalance(owner.address)).sub(before).add(gas).toString(), "1000000000");
      assert.equal((await weth.balanceOf(owner.address)).toString(), "0");
      assert.equal(await legacy.eoaStorageToken(), ethers.constants.AddressZero);
      assert.equal((await ethers.provider.getBalance(uni.address)).toString(), uniEth.toString(), "Uniswap untouched");
    });

    it("owner unswap of WETH honours the deadline", async function () {
      const { owner, router, legacyId } = await withStorageToken("weth");
      const now = await currentTime();
      await expectRevert(router.connect(owner).unswap(legacyId, 1_000_000_000, 0, now - 1), "SwapExpired()");
    });

    it("owner unswap of a non-WETH token needs a nonzero minimum, then swaps as before", async function () {
      const { owner, router, legacyId, legacy } = await withStorageToken("usdc");
      const now = await currentTime();
      await expectRevert(router.connect(owner).unswap(legacyId, 1_000_000_000, 0, now + 3600), "ZeroAmountOutMin()");
      await router.connect(owner).unswap(legacyId, 1_000_000_000, 1, now + 3600);
      assert.equal(await legacy.eoaStorageToken(), ethers.constants.AddressZero);
    });
  });

  describe("ETH to the owner with a checked call", function () {
    it("an owner that is a contract (or an EIP-7702 account) can withdraw and delete", async function () {
      const { dev, bene, router, verifierTerm } = await loadFixture(fixture);
      // Tx-based consent: the contract owner cannot sign the agreement message.
      await verifierTerm.connect(dev).setActiveTerms("v2026-11", ethers.utils.id("terms"));
      await verifierTerm.connect(dev).setConsentRecorder(router.address, true);
      const wallet = await (await ethers.getContractFactory("MockContractOwner")).deploy();
      const zero = { user: ethers.constants.AddressZero, percent: 0 };
      const create = router.interface.encodeFunctionData("createLegacyV2", [
        [{ user: bene.address, percent: 1000000 }],
        { lackOfOutgoingTxRange: DAY, delayLayer2: 0, delayLayer3: 0 },
        zero,
        zero,
        { permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 }, signature: "0x" },
        0,
        "0x",
      ]);
      await wallet.exec(router.address, create);
      const legacyId = await router._legacyId();
      const legacyAddress = await router.legacyAddresses(legacyId);
      await wallet.exec(legacyAddress, "0x", { value: 1000 });

      await wallet.exec(router.address, router.interface.encodeFunctionData("withdraw", [legacyId, 400]));
      assert.equal((await wallet.received()).toString(), "400", "receive() costs more than 2,300 gas and still lands");
      await wallet.exec(router.address, router.interface.encodeFunctionData("deleteLegacy", [legacyId]));
      assert.equal((await wallet.received()).toString(), "1000");
      assert.equal((await ethers.provider.getBalance(legacyAddress)).toString(), "0");
    });
  });

  describe("legacy-claim-fee-cap", function () {
    it("a new legacy refuses a claim fee above 50 bps, whoever set it on Payment", async function () {
      const { owner, bene, router } = await loadFixture(fixture51);
      let caught: any;
      try {
        await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      } catch (e) {
        caught = e;
      }
      assert(caught && revertedWith(caught, "AdminFeeAboveCap(uint256)"), `got: ${caught?.message}`);
    });

    it("50 bps is accepted and snapshotted", async function () {
      const { owner, bene, router } = await loadFixture(fixture50);
      const { legacy } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      assert.equal((await legacy.adminFeePercent()).toString(), "50");
      assert.equal((await legacy.MAX_ADMIN_FEE_BPS()).toString(), "50");
    });

    it("createLegacyV2WithMaxFee binds the fee the creator was shown", async function () {
      const { owner, bene, router } = await loadFixture(fixture); // Payment at 25 bps
      let caught: any;
      try {
        await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }], { maxFeeBps: 20 });
      } catch (e) {
        caught = e;
      }
      assert(caught && revertedWith(caught, "FeeAboveMax(uint256,uint256)"), `got: ${caught?.message}`);
      assert.equal(await router.isCreateLegacy(owner.address), false, "the whole create rolled back");

      const { legacy } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }], { maxFeeBps: 25 });
      assert.equal((await legacy.adminFeePercent()).toString(), "25");
    });

    it("createLegacyV2 without a bound keeps working (app compatibility during the switch)", async function () {
      const { owner, bene, router, vault } = await loadFixture(fixture);
      const { legacy } = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }]);
      assert.equal(await vault.boundLegacy(owner.address), legacy.address, "binds in vault v2");
    });
  });
});
