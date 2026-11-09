import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { DAY, deployTrain, createLegacyV2 } from "./fixtures/eoaTrain";

// The claim fee without a swap (founder decision 2026-11-09,
// docs/plans/train-2026-11.md): an ERC-20 fee goes from the owner's wallet to
// Payment as the token itself, on the rail the payout uses (direct allowance,
// Permit2 with the clone as spender, the pull vault); an ETH fee stays ETH. A
// fee that cannot be transferred is not collected and never reverts a claim.
// Both the next base clone (TransferEOALegacy at HEAD) and v3 are covered.

const MAX = ethers.constants.MaxUint256;
const MAX160 = ethers.BigNumber.from(2).pow(160).sub(1);
const ZERO = ethers.constants.AddressZero;
const T = 1_000_000_000;
const REVERT_ALWAYS = "0x60006000fd";

type Rail = "direct" | "permit2" | "vault";
const RAILS: Rail[] = ["direct", "permit2", "vault"];

const v3Options = { implName: "TransferEOALegacyV3", implArgs: (c: any) => [c.nftAllowlist], withNftAllowlist: true };

async function waveA() {
  return deployTrain();
}
async function v3() {
  return deployTrain(v3Options);
}

async function withAwkward(f: any) {
  const awk = await (await ethers.getContractFactory("MockAwkwardERC20")).deploy();
  await awk.mint(f.owner.address, T);
  return awk;
}

async function grant(f: any, legacy: any, token: any, rail: Rail) {
  if (rail === "direct") {
    await token.connect(f.owner).approve(legacy.address, MAX);
    return;
  }
  await token.connect(f.owner).approve(f.permit2.address, MAX);
  const spender = rail === "permit2" ? legacy.address : f.vault.address;
  await f.permit2.connect(f.owner).approve(token.address, spender, MAX160, (await currentTime()) + 365 * DAY);
}

const sixtyForty = (f: any) => [
  { user: f.bene.address, percent: 600000 },
  { user: f.bene2.address, percent: 400000 },
];

const feeOf = (amount: number) => Math.floor((amount * 25) / 10_000);

for (const [label, fixture, contractName] of [
  ["wave A base clone at HEAD", waveA, "TransferEOALegacy"],
  ["v3, whole estate", v3, "TransferEOALegacyV3"],
] as const) {
  describe(`Train 2026-11 — claim fee without a swap (${label})`, function () {
    this.timeout(300000);

    for (const rail of RAILS) {
      it(`${rail} rail: the fee token reaches Payment as is; the legacy keeps nothing, nothing is swapped`, async function () {
        const f = await loadFixture(fixture);
        const { owner, bene, bene2, router, payment, uni } = f;
        const awk = await withAwkward(f);
        const { legacy, legacyId } = await createLegacyV2(router, owner, sixtyForty(f), { contractName });
        await grant(f, legacy, awk, rail);
        const paymentEth = await ethers.provider.getBalance(payment.address);
        const uniEth = await ethers.provider.getBalance(uni.address);

        await increase(DAY + 1);
        await router.connect(bene).activeLegacy(legacyId, [awk.address], false);

        const fee = feeOf(T);
        const net = T - fee;
        assert.equal((await awk.balanceOf(payment.address)).toString(), String(fee));
        assert.equal((await awk.balanceOf(bene.address)).toString(), String(Math.floor((net * 6) / 10)));
        assert.equal((await awk.balanceOf(bene2.address)).toString(), String(net - Math.floor((net * 6) / 10)));
        assert.equal((await awk.balanceOf(owner.address)).toString(), "0");
        assert.equal((await awk.balanceOf(legacy.address)).toString(), "0");
        assert.equal((await awk.balanceOf(uni.address)).toString(), "0", "no swap");
        assert((await ethers.provider.getBalance(payment.address)).eq(paymentEth));
        assert((await ethers.provider.getBalance(uni.address)).eq(uniEth));
      });

      it(`${rail} rail: a fee transfer that reverts (the token blocklists Payment) still pays the heirs in full`, async function () {
        const f = await loadFixture(fixture);
        const { owner, bene, bene2, router, payment } = f;
        const awk = await withAwkward(f);
        const { legacy, legacyId } = await createLegacyV2(router, owner, sixtyForty(f), { contractName });
        await grant(f, legacy, awk, rail);
        await awk.setBlocked(payment.address, true);

        await increase(DAY + 1);
        await router.connect(bene).activeLegacy(legacyId, [awk.address], false);

        const fee = feeOf(T);
        const net = T - fee;
        assert.equal((await awk.balanceOf(bene.address)).toString(), String(Math.floor((net * 6) / 10)));
        assert.equal((await awk.balanceOf(bene2.address)).toString(), String(net - Math.floor((net * 6) / 10)));
        assert.equal((await awk.balanceOf(payment.address)).toString(), "0");
        // Not collected and not owed: the fee never left the owner's wallet.
        assert.equal((await awk.balanceOf(owner.address)).toString(), String(fee));
        assert.equal(await legacy.isLive(), false);
      });
    }

    it("ETH: the fee stays ETH; a Payment that refuses ETH still lets the heirs claim", async function () {
      const f = await loadFixture(fixture);
      const { owner, bene, bene2, router, payment } = f;
      const { legacy, legacyId } = await createLegacyV2(router, owner, sixtyForty(f), { contractName });
      await owner.sendTransaction({ to: legacy.address, value: T });
      await ethers.provider.send("hardhat_setCode", [payment.address, REVERT_ALWAYS]);
      const b2 = await ethers.provider.getBalance(bene2.address);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [], true);

      const fee = feeOf(T);
      const net = T - fee;
      assert.equal((await ethers.provider.getBalance(bene2.address)).sub(b2).toString(), String(net - Math.floor((net * 6) / 10)));
      assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), String(fee), "the refused fee stays in the legacy");
    });
  });
}

describe("Train 2026-11 — claim fee without a swap (v3, per-share mode)", function () {
  this.timeout(300000);

  async function perShare(f: any) {
    const { owner, bene, bene3, router } = f;
    const { legacy, legacyId } = await createLegacyV2(router, owner, sixtyForty(f), { contractName: "TransferEOALegacyV3" });
    await legacy.connect(owner).setBackupLines(30 * DAY, [{ primary: bene.address, second: bene3.address, third: ZERO }]);
    return { legacy, legacyId };
  }

  for (const rail of RAILS) {
    it(`${rail} rail: each share's fee reaches Payment as the token itself`, async function () {
      const f = await loadFixture(v3);
      const { owner, bene, bene2, router, payment, uni } = f;
      const awk = await withAwkward(f);
      const { legacy, legacyId } = await perShare(f);
      await grant(f, legacy, awk, rail);
      const paymentEth = await ethers.provider.getBalance(payment.address);

      await increase(DAY + 1);
      await router.connect(bene).activeLegacy(legacyId, [awk.address], false);
      assert.equal((await awk.balanceOf(bene.address)).toString(), String(600_000_000 - feeOf(600_000_000)));
      assert.equal((await awk.balanceOf(payment.address)).toString(), String(feeOf(600_000_000)));
      await router.connect(bene2).activeLegacy(legacyId, [awk.address], false);
      assert.equal((await awk.balanceOf(bene2.address)).toString(), String(400_000_000 - feeOf(400_000_000)));
      assert.equal((await awk.balanceOf(payment.address)).toString(), String(feeOf(T)));
      assert.equal((await awk.balanceOf(owner.address)).toString(), "0");
      assert.equal((await awk.balanceOf(legacy.address)).toString(), "0");
      assert.equal((await awk.balanceOf(uni.address)).toString(), "0", "no swap");
      assert((await ethers.provider.getBalance(payment.address)).eq(paymentEth));
    });
  }

  it("a fee that reverts still pays the share; the uncollected fee stays in the pot and is never paid twice", async function () {
    const f = await loadFixture(v3);
    const { owner, bene, bene2, router, payment } = f;
    const awk = await withAwkward(f);
    const { legacy, legacyId } = await perShare(f);
    await grant(f, legacy, awk, "vault");
    await awk.setBlocked(payment.address, true);

    await increase(DAY + 1);
    await router.connect(bene).activeLegacy(legacyId, [awk.address], false);
    assert.equal((await awk.balanceOf(bene.address)).toString(), "598500000");
    assert.equal((await awk.balanceOf(owner.address)).toString(), "401500000", "B's 400 plus A's uncollected fee");
    assert.equal((await legacy.totalReleased(awk.address)).toString(), "600000000");

    // B's due is 40% of everything made available, the uncollected fee included.
    await router.connect(bene2).activeLegacy(legacyId, [awk.address], false);
    assert.equal((await awk.balanceOf(bene2.address)).toString(), String(400_600_000 - feeOf(400_600_000)));
    assert.equal((await awk.balanceOf(payment.address)).toString(), "0");

    // Payment unblocked: A takes 60% of the fees that were never collected.
    await awk.setBlocked(payment.address, false);
    await router.connect(bene).activeLegacy(legacyId, [awk.address], false);
    const aDue = 601_500_900 - 600_000_000;
    assert.equal((await awk.balanceOf(bene.address)).toString(), String(598_500_000 + aDue - feeOf(aDue)));
    assert.equal((await awk.balanceOf(payment.address)).toString(), String(feeOf(aDue)));
    const held = (await awk.balanceOf(owner.address))
      .add(await awk.balanceOf(bene.address))
      .add(await awk.balanceOf(bene2.address))
      .add(await awk.balanceOf(payment.address));
    assert.equal(held.toString(), String(T), "conserved");
    assert.equal((await legacy.totalReleased(awk.address)).toString(), String(600_000_000 + 400_600_000 + aDue));
  });

  it("ETH: the fee stays ETH; a refused ETH fee stays in the legacy and flows into the pot", async function () {
    const f = await loadFixture(v3);
    const { owner, bene, bene2, router, payment } = f;
    const { legacy, legacyId } = await perShare(f);
    await owner.sendTransaction({ to: legacy.address, value: T });
    const paymentEth = await ethers.provider.getBalance(payment.address);

    await increase(DAY + 1);
    await router.connect(bene).activeLegacy(legacyId, [], true);
    assert.equal((await ethers.provider.getBalance(payment.address)).sub(paymentEth).toString(), String(feeOf(600_000_000)));
    assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), "400000000");

    await ethers.provider.send("hardhat_setCode", [payment.address, REVERT_ALWAYS]);
    const before = await ethers.provider.getBalance(bene2.address);
    const rc = await (await router.connect(bene2).activeLegacy(legacyId, [], true)).wait();
    const gas = rc.gasUsed.mul(rc.effectiveGasPrice);
    assert.equal((await ethers.provider.getBalance(bene2.address)).add(gas).sub(before).toString(), String(400_000_000 - feeOf(400_000_000)));
    assert.equal((await ethers.provider.getBalance(legacy.address)).toString(), String(feeOf(400_000_000)), "the refused fee stays here");
    assert.equal((await legacy.totalReleased(ZERO)).toString(), String(T));
  });
});
