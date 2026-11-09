import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2, expectRevert } from "./fixtures/eoaTrain";

// Review round 2 (docs/plans/train-2026-11.md): the new router guards the
// unswap claim for EXISTING clones, which have neither the zero-minimum nor
// the sole-recipient check. The clone here runs the runtime code live on
// mainnet today (0xdDea11D9…, test/fixtures/live), behind the new router.

const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "live", "mainnet-implementations.json"), "utf-8"));
const MAX = ethers.constants.MaxUint256;

describe("Train 2026-11 — the new router guards existing clones' unswap claim", function () {
  this.timeout(200000);

  async function fixture() {
    const f = await deployTrain();
    const liveClone = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [liveClone, LIVE.implementations.TransferEOALegacyClone.code]);
    // Vault v2 only binds the new clone; old clones ran without it or on v1.
    await f.router.connect(f.timelock).setPullVault(ethers.constants.AddressZero);
    await f.router.connect(f.timelock).setLegacyImplementation(liveClone);
    await f.usdc.mint(f.uni.address, ethers.utils.parseUnits("1000000", 6));
    return { ...f, liveClone };
  }

  async function oldLegacy(f: any, distributions: any[], storage: "usdc" | "weth") {
    const { owner, router, usdc, weth } = f;
    const { legacy, legacyId } = await createLegacyV2(router, owner, distributions);
    const token = storage === "usdc" ? usdc : weth;
    const now = await currentTime();
    await router.connect(owner).autoSwap(legacyId, { storageToken: token.address, amountOutMin: 1, deadline: now + 3600 }, { value: 1_000_000_000 });
    await token.connect(owner).approve(legacy.address, MAX);
    assert.equal(await legacy.eoaStorageToken(), token.address);
    await increase(DAY + 1);
    return { legacy, legacyId, deadline: now + 3600 + DAY };
  }

  const halves = (f: any) => [
    { user: f.bene.address, percent: 500000 },
    { user: f.bene2.address, percent: 500000 },
  ];

  it("the legacy really runs the live clone code", async function () {
    const f = await loadFixture(fixture);
    const { legacy } = await createLegacyV2(f.router, f.owner, halves(f));
    const code = await ethers.provider.getCode(legacy.address);
    assert(code.toLowerCase().includes(f.liveClone.slice(2).toLowerCase()), "EIP-1167 clone of the live implementation");
    assert.equal((await legacy.MAX_TRANSFER()).toString(), "100");
  });

  it("a co-beneficiary's unswap claim is refused, with or without a minimum; their token claim works", async function () {
    const f = await loadFixture(fixture);
    const { bene, bene2, router, usdc } = f;
    const { legacyId, deadline } = await oldLegacy(f, halves(f), "usdc");
    await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, deadline), "ZeroAmountOutMin()");
    await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 1, deadline), "UnswapNeedsSoleRecipient()");
    await router.connect(bene).activeLegacy(legacyId, [usdc.address], false);
    assert((await usdc.balanceOf(bene.address)).gt(0) && (await usdc.balanceOf(bene2.address)).gt(0), "both receive the token");
  });

  it("a sole recipient still swaps with a minimum, and a zero minimum is refused", async function () {
    const f = await loadFixture(fixture);
    const { bene, router } = f;
    const { legacyId, deadline } = await oldLegacy(f, [{ user: bene.address, percent: 1000000 }], "usdc");
    await expectRevert(router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, deadline), "ZeroAmountOutMin()");
    const before = await ethers.provider.getBalance(bene.address);
    const rc = await (await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 1, deadline)).wait();
    const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
    assert((await ethers.provider.getBalance(bene.address)).add(gas).gt(before), "swapped ETH received");
  });

  // Round 10: the guard applies only when the clone would convert something,
  // computed with the rule every clone vintage uses: min(owner's balance,
  // owner's direct allowance to the clone).
  for (const empty of ["balance", "allowance"] as const) {
    it(`nothing to convert (zero ${empty}): a co-beneficiary's unswap claim with a zero minimum passes and swaps nothing`, async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, other, router, usdc, uni } = f;
      const { legacy, legacyId, deadline } = await oldLegacy(f, halves(f), "usdc");
      if (empty === "balance") await usdc.connect(owner).transfer(other.address, await usdc.balanceOf(owner.address));
      else await usdc.connect(owner).approve(legacy.address, 0);
      const ownerUsdc = await usdc.balanceOf(owner.address);
      const uniUsdc = await usdc.balanceOf(uni.address);
      await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, deadline);
      assert.equal(await legacy.eoaStorageToken(), ethers.constants.AddressZero);
      assert.equal((await legacy.getIsActiveLegacy()).toString(), "2", "claimed");
      assert((await usdc.balanceOf(owner.address)).eq(ownerUsdc), "nothing pulled");
      assert((await usdc.balanceOf(uni.address)).eq(uniUsdc), "nothing swapped");
    });
  }

  it("a WETH storage token needs neither guard: co-beneficiaries unwrap with a zero minimum", async function () {
    const f = await loadFixture(fixture);
    const { bene, bene2, router } = f;
    const { legacyId, deadline } = await oldLegacy(f, halves(f), "weth");
    const before = await ethers.provider.getBalance(bene2.address);
    await router.connect(bene).activeLegacyAndUnswap(legacyId, [], 0, deadline);
    assert((await ethers.provider.getBalance(bene2.address)).gt(before), "the co-beneficiary got their ETH half");
  });
});
