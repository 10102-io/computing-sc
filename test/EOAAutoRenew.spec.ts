import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
import { wireRouters } from "./fixtures/wiring";

// EOA activity auto-renew, Phase 1 (ROADMAP track 4). Owner-opt-in,
// attestor-driven inactivity-timer renewal with four hard bounds: opt-in
// (premium-gated), strictly-increasing attested nonce, near-deadline window,
// and a budget since the owner's last REAL check-in. Trust model under test:
// a compromised attestor can only DELAY activation, never accelerate it.

const uniRouter = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const EMPTY_BUNDLE = {
  permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 },
  signature: "0x",
};

const DAY = 86400;

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("EOA activity auto-renew (Phase 1)", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, attestor, owner, bene, other] = await ethers.getSigners();

    const mockArtifact = await artifacts.readArtifact("MockPermit2");
    await ethers.provider.send("hardhat_setCode", [PERMIT2_ADDRESS, mockArtifact.deployedBytecode]);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    const premiumRegistry = await deployProxy(
      "PremiumRegistry",
      [
        usdt.address,
        usdc.address,
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0x694AA1769357215DE4FAC081bf1f309aDC325306",
        premiumSetting.address,
        payment.address,
      ],
      "initialize",
      dev
    );

    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      uniRouter,
      weth,
    ]);
    await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);

    const multisigLegacyRouter = await deployProxy("MultisigLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
    ]);

    await wireRouters({
      admin: dev,
      legacyDeployerAdmin: treasury,
      premiumSetting,
      premiumRegistry,
      legacyDeployer,
      verifierTerm,
      transferEOALegacyRouter,
      multisigLegacyRouter,
    });

    const TransferEOALegacy = await ethers.getContractFactory("TransferEOALegacy");
    const legacyImpl = await TransferEOALegacy.deploy();
    await transferEOALegacyRouter.connect(dev).setLegacyImplementation(legacyImpl.address);

    await transferEOALegacyRouter.connect(dev).setActivityAttestor(attestor.address);

    // Grant the owner premium by impersonating the registry (the only caller
    // allowed to write premium time on PremiumSetting).
    await ethers.provider.send("hardhat_impersonateAccount", [premiumRegistry.address]);
    await ethers.provider.send("hardhat_setBalance", [premiumRegistry.address, "0x1000000000000000000"]);
    const registrySigner = await ethers.getSigner(premiumRegistry.address);
    await premiumSetting.connect(registrySigner).updatePremiumTime(owner.address, 100 * 365 * DAY);

    await usdt.mint(owner.address, 1_000_000_000);

    return {
      treasury, dev, attestor, owner, bene, other,
      transferEOALegacyRouter, premiumSetting, usdt,
    };
  }

  async function createLegacy(router: any, ownerSigner: any, beneAddr: string, triggerSeconds: number) {
    const extraConfig = { lackOfOutgoingTxRange: triggerSeconds, delayLayer2: 0, delayLayer3: 0 };
    const zero = { user: ethers.constants.AddressZero, percent: 0 };
    const predicted: string = await router.getNextLegacyAddress(ownerSigner.address);
    const ts = await currentTime();
    const sig = await ownerSigner.signMessage(await genMessage(ts));
    await router
      .connect(ownerSigner)
      .createLegacyV2([{ user: beneAddr, percent: 1000000 }], extraConfig, zero, zero, EMPTY_BUNDLE, ts, sig);
    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);
    const legacyId = (await legacy.getLegacyInfo())[0];
    return { legacy, legacyId };
  }

  it("setAutoRenew: owner-only, premium-gated, evented; disable is always allowed", async function () {
    const { owner, bene, other, transferEOALegacyRouter, premiumSetting, dev } = await loadFixture(deployFixture);
    const { legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);

    // Not the owner.
    try {
      await transferEOALegacyRouter.connect(other).setAutoRenew(legacyId, true);
      assert.fail("non-owner enable should revert");
    } catch (err) {
      assert(revertedWith(err, "OnlyOwner()"), `unexpected: ${err}`);
    }

    // Owner, premium → on.
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);
    let state = await transferEOALegacyRouter.autoRenewState(legacyId);
    assert.equal(state.enabled, true);
    assert(state.budgetAnchor.gt(0), "budget anchored at consent");

    // Premium lapses → enable blocked, disable still allowed.
    await premiumSetting.connect(dev).resetPremium(owner.address);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, false);
    state = await transferEOALegacyRouter.autoRenewState(legacyId);
    assert.equal(state.enabled, false);
    try {
      await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);
      assert.fail("non-premium enable should revert");
    } catch (err) {
      assert(revertedWith(err, "AutoRenewNotPremium()"), `unexpected: ${err}`);
    }
  });

  it("happy path: attested activity near the deadline resets the timer (attestor pays the gas, owner does nothing)", async function () {
    const { attestor, owner, bene, transferEOALegacyRouter } = await loadFixture(deployFixture);
    const { legacy, legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    await increase(65 * DAY); // 25 days to deadline — inside the 30-day window
    const before = await legacy.getLastTimestamp();
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 7);
    const after = await legacy.getLastTimestamp();
    assert(after.gt(before), "timer must reset");

    const state = await transferEOALegacyRouter.autoRenewState(legacyId);
    assert.equal(state.lastNonceSeen.toString(), "7");
  });

  it("bounds: attestor-only, opt-in-only, monotonic nonce, near-deadline window", async function () {
    const { attestor, owner, bene, other, transferEOALegacyRouter } = await loadFixture(deployFixture);
    const { legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);

    // Not the attestor.
    try {
      await transferEOALegacyRouter.connect(other).recordActivity(legacyId, 1);
      assert.fail("non-attestor should revert");
    } catch (err) {
      assert(revertedWith(err, "NotActivityAttestor()"), `unexpected: ${err}`);
    }

    // Owner never opted in.
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("not-opted-in should revert");
    } catch (err) {
      assert(revertedWith(err, "AutoRenewDisabled()"), `unexpected: ${err}`);
    }

    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    // Too far from the deadline (10 of 90 days elapsed, window is 30).
    await increase(10 * DAY);
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("outside the window should revert");
    } catch (err) {
      assert(revertedWith(err, "AutoRenewTooEarly()"), `unexpected: ${err}`);
    }

    // Inside the window: works once per fresh nonce, replay rejected.
    await increase(55 * DAY);
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("nonce replay should revert");
    } catch (err) {
      assert(revertedWith(err, "StaleActivityNonce()"), `unexpected: ${err}`);
    }
  });

  it("nonce baseline survives disable/re-enable — no replay after a toggle", async function () {
    const { attestor, owner, bene, transferEOALegacyRouter } = await loadFixture(deployFixture);
    const { legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    await increase(65 * DAY);
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 42);

    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, false);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    await increase(65 * DAY);
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 42);
      assert.fail("pre-toggle observation should not be replayable");
    } catch (err) {
      assert(revertedWith(err, "StaleActivityNonce()"), `unexpected: ${err}`);
    }
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 43);
  });

  it("budget: exhausts after 12 months without a real check-in; a real check-in refills it", async function () {
    const { attestor, owner, bene, transferEOALegacyRouter } = await loadFixture(deployFixture);
    // 390-day trigger: the renewal window opens on day 360, the budget dies
    // on day 365 — so both "window open + budget spent" (day 380) and
    // "window open + budget alive" (day 362 after a refill) are reachable.
    const { legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 390 * DAY);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    await increase(380 * DAY); // inside the window (10 days left) but budget (365d) is spent
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("exhausted budget should revert");
    } catch (err) {
      assert(revertedWith(err, "AutoRenewBudgetExhausted()"), `unexpected: ${err}`);
    }

    // Owner checks in for real → timer AND budget refill.
    await transferEOALegacyRouter.connect(owner).avtiveAlive(legacyId);

    await increase(362 * DAY); // in window (28 days left), within the refreshed budget
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1); // works again
  });

  it("cannot accelerate: a renewal only ever pushes the activation deadline out", async function () {
    const { attestor, owner, bene, transferEOALegacyRouter } = await loadFixture(deployFixture);
    const { legacy, legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);

    await increase(65 * DAY);
    const [deadlineBefore] = await legacy.getTriggerActivationTimestamp();
    await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
    const [deadlineAfter] = await legacy.getTriggerActivationTimestamp();
    assert(deadlineAfter.gt(deadlineBefore), "deadline can only move away");
  });

  it("premium lapse pauses renewals; a deleted legacy cannot be renewed", async function () {
    const { attestor, dev, owner, bene, transferEOALegacyRouter, premiumSetting } = await loadFixture(deployFixture);
    const { legacyId } = await createLegacy(transferEOALegacyRouter, owner, bene.address, 90 * DAY);
    await transferEOALegacyRouter.connect(owner).setAutoRenew(legacyId, true);
    await increase(65 * DAY);

    await premiumSetting.connect(dev).resetPremium(owner.address);
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("lapsed premium should revert");
    } catch (err) {
      assert(revertedWith(err, "AutoRenewNotPremium()"), `unexpected: ${err}`);
    }

    // Deleted legacy: the clone's own gate rejects the renewal.
    await transferEOALegacyRouter.connect(owner).deleteLegacy(legacyId);
    try {
      await transferEOALegacyRouter.connect(attestor).recordActivity(legacyId, 1);
      assert.fail("deleted legacy should revert");
    } catch (err) {
      assert(err, "expected revert");
    }
  });
});
