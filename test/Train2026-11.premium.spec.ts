import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { deployProxy } from "./utils/proxy";
import { expectRevert } from "./fixtures/eoaTrain";

// PremiumRegistry, wave A (docs/plans/train-2026-11.md): DEFERRED
// premium-coupons and referral-onchain in one upgrade. New `subscribeWith*`
// entry points; `subcribeWith*` and `PlanSubcribed` are unchanged.

const YEAR = 365 * 86400;
const PRICE_CENTS = 9900; // $99.00

describe("Train 2026-11 — PremiumRegistry coupons and referrals", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, buyer, partner, other, safe] = await ethers.getSigners();
    const usdt = await (await ethers.getContractFactory("MockNoReturnERC20")).deploy("Tether USD", "USDT", 6);
    const usdc = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
    const Agg = await ethers.getContractFactory("MockV3Aggregator");
    const usdFeed = await Agg.deploy(8, 100000000);
    const ethFeed = await Agg.deploy(8, 200000000000); // $2,000
    const setting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const payment = await (await ethers.getContractFactory("Payment")).deploy();
    const registry = await deployProxy("PremiumRegistry", [
      usdt.address, usdc.address, usdFeed.address, usdFeed.address, ethFeed.address, setting.address, payment.address,
    ]);
    await setting.connect(dev).setParams(registry.address, ethers.constants.AddressZero, other.address, other.address);
    await registry.createPlans([YEAR], [PRICE_CENTS], ["Annual"], [""], [""]);
    await registry.grantRole(await registry.DEFAULT_ADMIN_ROLE(), safe.address);

    for (const t of [usdt, usdc]) {
      await t.mint(buyer.address, 1_000_000_000);
      await t.connect(buyer).approve(registry.address, ethers.constants.MaxUint256);
    }
    const nextYear = async () => {
      await increase(YEAR + 1);
      // Keep the mock feeds inside ORACLE_STALE_LIMIT after the jump.
      await usdFeed.updateAnswer(100000000);
      await ethFeed.updateAnswer(200000000000);
    };
    return { treasury, dev, buyer, partner, other, safe, usdt, usdc, registry, setting, payment, nextYear };
  }

  const PRICE_6DP = 99_000_000; // $99 at $1.00 per token

  function eventArgs(rc: any, name: string) {
    const ev = rc.events?.find((e: any) => e.event === name);
    assert(ev, `${name} missing`);
    return ev.args;
  }

  describe("admin", function () {
    it("coupons are operator-set and capped at 50%; referrer shares are admin-set and capped at 30%", async function () {
      const { treasury, other, safe, partner, registry } = await loadFixture(deployFixture);
      await expectRevert(registry.connect(other).setCoupon("X", 1000, 0, 0, partner.address, true), "AccessControlUnauthorizedAccount(address,bytes32)");
      await expectRevert(registry.connect(treasury).setCoupon("", 1000, 0, 0, partner.address, true), "InvalidCoupon()");
      await expectRevert(registry.connect(treasury).setCoupon("X", 5001, 0, 0, partner.address, true), "CouponDiscountTooHigh()");
      await registry.connect(treasury).setCoupon("X", 5000, 0, 0, partner.address, true);

      await expectRevert(registry.connect(other).setReferrer(partner.address, 1000), "AccessControlUnauthorizedAccount(address,bytes32)");
      await expectRevert(registry.connect(safe).setReferrer(partner.address, 3001), "ReferrerShareTooHigh()");
      await registry.connect(safe).setReferrer(partner.address, 3000);
      assert.equal(await registry.referrerShareBps(partner.address), 3000);
    });
  });

  describe("subscribe with a code", function () {
    it("a 20% coupon cuts the price, counts a use, grants premium, and emits both events", async function () {
      const { treasury, buyer, registry, setting, payment, usdc } = await loadFixture(deployFixture);
      await registry.connect(treasury).setCoupon("NOTAIRE20", 2000, 0, 0, ethers.constants.AddressZero, true);
      assert.equal(await registry.couponDiscountBps("NOTAIRE20"), 2000);

      const rc = await (await registry.connect(buyer).subscribeWithUSDC(0, "NOTAIRE20", ethers.constants.AddressZero)).wait();
      const paid = PRICE_6DP - (PRICE_6DP * 2000) / 10_000;
      assert.equal((await usdc.balanceOf(payment.address)).toString(), String(paid));
      assert(await setting.isPremium(buyer.address));
      assert.equal((await registry.coupons(ethers.utils.id("NOTAIRE20"))).uses, 1);
      assert.equal(eventArgs(rc, "PlanSubcribed").value.toString(), String(paid));
      const withCode = eventArgs(rc, "PlanSubscribedWithCode");
      assert.equal(withCode.code, "NOTAIRE20");
      assert.equal(withCode.referrerShare.toString(), "0");
    });

    it("a coupon naming a registered referrer pays that referrer's share straight from the buyer", async function () {
      const { treasury, safe, buyer, partner, other, registry, payment, usdc } = await loadFixture(deployFixture);
      await registry.connect(safe).setReferrer(partner.address, 1000);
      await registry.connect(treasury).setCoupon("PARTNER", 1000, 0, 0, partner.address, true);
      // The coupon's referrer wins over the referrer argument.
      const rc = await (await registry.connect(buyer).subscribeWithUSDC(0, "PARTNER", other.address)).wait();
      const paid = PRICE_6DP - PRICE_6DP / 10;
      const share = paid / 10;
      assert.equal((await usdc.balanceOf(partner.address)).toString(), String(share));
      assert.equal((await usdc.balanceOf(payment.address)).toString(), String(paid - share));
      const ev = eventArgs(rc, "PlanSubscribedWithCode");
      assert.equal(ev.referrer, partner.address);
      assert.equal(ev.referrerShare.toString(), String(share));
    });

    it("a referrer without a coupon: registered is paid, unregistered is only attributed, self-referral is never paid", async function () {
      const { safe, buyer, partner, other, registry, payment, usdt, nextYear } = await loadFixture(deployFixture);
      await registry.connect(safe).setReferrer(partner.address, 2000);
      // USDT returns nothing: the split rides SafeERC20 too.
      await registry.connect(buyer).subscribeWithUSDT(0, "", partner.address);
      assert.equal((await usdt.balanceOf(partner.address)).toString(), String(PRICE_6DP / 5));
      assert.equal((await usdt.balanceOf(payment.address)).toString(), String(PRICE_6DP - PRICE_6DP / 5));

      await nextYear();
      const rc = await (await registry.connect(buyer).subscribeWithUSDT(0, "", other.address)).wait();
      assert.equal(eventArgs(rc, "PlanSubscribedWithCode").referrer, other.address);
      assert.equal(eventArgs(rc, "PlanSubscribedWithCode").referrerShare.toString(), "0");

      await registry.connect(safe).setReferrer(buyer.address, 3000);
      await nextYear();
      const self = await (await registry.connect(buyer).subscribeWithUSDT(0, "", buyer.address)).wait();
      assert.equal(eventArgs(self, "PlanSubscribedWithCode").referrerShare.toString(), "0");
    });

    it("a referrer the token refuses forfeits the share; the purchase still lands", async function () {
      const { safe, buyer, partner, registry, payment, usdc, setting } = await loadFixture(deployFixture);
      await registry.connect(safe).setReferrer(partner.address, 1000);
      await usdc.setBlocked(partner.address, true);
      await registry.connect(buyer).subscribeWithUSDC(0, "", partner.address);
      assert.equal((await usdc.balanceOf(payment.address)).toString(), String(PRICE_6DP));
      assert(await setting.isPremium(buyer.address));
    });

    it("unknown, inactive, expired and used-up codes revert instead of charging full price", async function () {
      const { treasury, buyer, registry, nextYear } = await loadFixture(deployFixture);
      const zero = ethers.constants.AddressZero;
      await expectRevert(registry.connect(buyer).subscribeWithUSDC(0, "NOPE", zero), "InvalidCoupon()");
      await registry.connect(treasury).setCoupon("OFF", 1000, 0, 0, zero, false);
      await expectRevert(registry.connect(buyer).subscribeWithUSDC(0, "OFF", zero), "InvalidCoupon()");
      const now = await currentTime();
      await registry.connect(treasury).setCoupon("OLD", 1000, now + 10, 0, zero, true);
      await increase(20);
      await expectRevert(registry.connect(buyer).subscribeWithUSDC(0, "OLD", zero), "InvalidCoupon()");
      assert.equal(await registry.couponDiscountBps("OLD"), 0);
      await registry.connect(treasury).setCoupon("ONCE", 1000, 0, 1, zero, true);
      await registry.connect(buyer).subscribeWithUSDC(0, "ONCE", zero);
      await nextYear();
      await expectRevert(registry.connect(buyer).subscribeWithUSDC(0, "ONCE", zero), "InvalidCoupon()");
    });

    it("ETH: refund of the excess, referrer paid, and a reverting referrer forfeits to Payment", async function () {
      const { treasury, safe, buyer, partner, registry, payment, nextYear } = await loadFixture(deployFixture);
      const hostile = await (await ethers.getContractFactory("MockHostilePayee")).deploy();
      await hostile.setRejectAll(true);
      await registry.connect(safe).setReferrer(partner.address, 1000);
      await registry.connect(safe).setReferrer(hostile.address, 1000);
      await registry.connect(treasury).setCoupon("HOSTILE", 0, 0, 0, hostile.address, true);
      const price = await registry.getPlanPriceETH(0);

      const partnerBefore = await ethers.provider.getBalance(partner.address);
      await registry.connect(buyer).subscribeWithETH(0, "", partner.address, { value: price.mul(2) });
      assert.equal((await ethers.provider.getBalance(partner.address)).sub(partnerBefore).toString(), price.div(10).toString());
      assert.equal((await ethers.provider.getBalance(payment.address)).toString(), price.sub(price.div(10)).toString());
      assert.equal((await ethers.provider.getBalance(registry.address)).toString(), "0", "nothing held by the registry");

      await nextYear();
      const payBefore = await ethers.provider.getBalance(payment.address);
      await registry.connect(buyer).subscribeWithETH(0, "HOSTILE", ethers.constants.AddressZero, { value: price });
      assert.equal((await ethers.provider.getBalance(payment.address)).sub(payBefore).toString(), price.toString());
      await expectRevert(registry.connect(buyer).subscribeWithETH(0, "", ethers.constants.AddressZero, { value: price.sub(1) }), "InsufficientETH()");
    });

    it("the v1 subcribe paths are untouched", async function () {
      const { buyer, registry, payment, usdc } = await loadFixture(deployFixture);
      const rc = await (await registry.connect(buyer).subcribeWithUSDC(0)).wait();
      assert.equal((await usdc.balanceOf(payment.address)).toString(), String(PRICE_6DP));
      assert(!rc.events?.some((e: any) => e.event === "PlanSubscribedWithCode"));
    });
  });
});
