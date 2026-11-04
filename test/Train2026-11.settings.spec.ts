import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { deployProxy } from "./utils/proxy";
import { expectRevert } from "./fixtures/eoaTrain";

// Wave A (docs/plans/train-2026-11.md):
// - PremiumSetting: the legacy's own Safe may also call the notification
//   setters (founder decision on DEFERRED "Multisig legacy creator-only
//   off-chain admin"); premium and timing stay the creator's.
// - EIP712LegacyVerifier: self-recorded consent (closes shield-vault-consent).

const YEAR = 365 * 86400;

describe("Train 2026-11 — PremiumSetting Safe admin", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [dev, creator, safe, stranger, router, multisigRouter, beneficiary] = await ethers.getSigners();
    const setting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const registry = ethers.Wallet.createRandom().address;
    await setting.connect(dev).setParams(registry, ethers.constants.AddressZero, router.address, multisigRouter.address);
    await ethers.provider.send("hardhat_impersonateAccount", [registry]);
    await ethers.provider.send("hardhat_setBalance", [registry, "0x1000000000000000000"]);
    const registrySigner = await ethers.getSigner(registry);
    await setting.connect(registrySigner).updatePremiumTime(creator.address, YEAR);

    const Mock = await ethers.getContractFactory("MockPremiumLegacy");
    // A multisig legacy records its Safe as owner and the submitting EOA as creator.
    const multisig = await Mock.deploy(creator.address, safe.address, multisigRouter.address, "m", 1, 1);
    await multisig.setLegacyType(1);
    // An EOA legacy: owner == creator.
    const eoa = await Mock.deploy(creator.address, creator.address, router.address, "e", 1, 1);

    return { dev, creator, safe, stranger, beneficiary, setting, multisig, eoa };
  }

  const recipients = { cosigners: [], beneficiaries: [], secondLine: ethers.constants.AddressZero, thirdLine: ethers.constants.AddressZero };

  it("the legacy's Safe sets and clears watchers; events stay keyed by the creator", async function () {
    const { creator, safe, stranger, setting, multisig } = await loadFixture(deployFixture);
    const rc = await (await setting.connect(safe).setWatchers(multisig.address, ["w"], [stranger.address], [true])).wait();
    const ev = rc.events?.find((e: any) => e.event === "WatcherUpdated");
    assert.equal(ev.args.user, creator.address);
    const rc2 = await (await setting.connect(safe).clearWatcher([multisig.address])).wait();
    assert.equal(rc2.events?.find((e: any) => e.event === "WatcherReset").args.user, creator.address);
    await expectRevert(setting.connect(stranger).setWatchers(multisig.address, ["w"], [stranger.address], [true]), "OnlyLegacyCreator()");
  });

  it("the Safe edits reminder recipients with the creator's timing; without it the edit reverts", async function () {
    const { creator, safe, setting, multisig } = await loadFixture(deployFixture);
    await expectRevert(setting.connect(safe).updateLegacyConfig([multisig.address], [recipients]), "UserConfigNotSet()");
    await setting.connect(creator).updateUserConfig(7 * 86400);
    const rc = await (await setting.connect(safe).updateLegacyConfig([multisig.address], [recipients])).wait();
    assert.equal(rc.events?.find((e: any) => e.event === "LegacyReminderUpdated").args.user, creator.address);
    const rc2 = await (await setting.connect(safe).clearLegacyConfig([multisig.address])).wait();
    assert.equal(rc2.events?.find((e: any) => e.event === "LegacyConfigReset").args.user, creator.address);
    await setting.connect(safe).clearLegacyPII([multisig.address]);
  });

  it("premium is the creator's: a lapsed creator blocks the Safe too", async function () {
    const { dev, creator, safe, setting, multisig } = await loadFixture(deployFixture);
    await setting.connect(dev).resetPremium(creator.address);
    await expectRevert(setting.connect(safe).setWatchers(multisig.address, ["w"], [safe.address], [true]), "PremiumOnly()");
    await expectRevert(setting.connect(creator).setWatchers(multisig.address, ["w"], [safe.address], [true]), "PremiumOnly()");
    // PII wipes are never premium-gated.
    await setting.connect(safe).clearLegacyPII([multisig.address]);
  });

  it("the creator path is unchanged, for multisig and EOA legacies; nobody else gets in", async function () {
    const { creator, safe, stranger, setting, multisig, eoa } = await loadFixture(deployFixture);
    await setting.connect(creator).setWatchers(multisig.address, ["w"], [stranger.address], [false]);
    await setting.connect(creator).setWatchers(eoa.address, ["w"], [stranger.address], [false]);
    await setting.connect(creator).setReminderConfigs(86400, [eoa.address], [recipients]);
    // An EOA legacy's owner is its creator: the Safe of some other legacy has no say.
    await expectRevert(setting.connect(safe).setWatchers(eoa.address, ["w"], [stranger.address], [false]), "OnlyLegacyCreator()");
    await expectRevert(setting.connect(stranger).clearLegacyConfig([eoa.address]), "OnlyLegacyCreator()");
  });
});

describe("Train 2026-11 — EIP712LegacyVerifier self-recorded consent", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [owner, user, vault] = await ethers.getSigners();
    const verifier = await deployProxy("EIP712LegacyVerifier", [owner.address]);
    const termsHash = ethers.utils.id("terms v2026-11");
    return { owner, user, vault, verifier, termsHash };
  }

  it("records the caller's acceptance of the active terms for a reference, with an event", async function () {
    const { owner, user, vault, verifier, termsHash } = await loadFixture(deployFixture);
    await expectRevert(verifier.connect(user).recordSelfConsent(termsHash, vault.address, 7), "NoActiveTerms()");
    await verifier.connect(owner).setActiveTerms("v2026-11", termsHash);

    const rc = await (await verifier.connect(user).recordSelfConsent(termsHash, vault.address, 7)).wait();
    const ev = rc.events?.find((e: any) => e.event === "SelfConsentRecorded");
    assert.equal(ev.args.user, user.address);
    assert.equal(ev.args.refContract, vault.address);
    assert.equal(ev.args.refId.toString(), "7");
    assert.equal(ev.args.termsVersion, "v2026-11");

    assert.equal((await verifier.getUserSelfConsentCount(user.address)).toString(), "1");
    const c = await verifier.getUserSelfConsent(user.address, 0);
    assert.equal(c.termsHash, termsHash);
    assert.equal(c.termsVersion, "v2026-11");
    assert.equal(c.refContract, vault.address);
    // The router-recorded log is a separate modality and stays untouched.
    assert.equal((await verifier.getUserConsentCount(user.address)).toString(), "0");
  });

  it("refuses terms the app did not show (a change between display and transaction) and a zero reference", async function () {
    const { owner, user, vault, verifier, termsHash } = await loadFixture(deployFixture);
    await verifier.connect(owner).setActiveTerms("v2026-11", termsHash);
    await expectRevert(verifier.connect(user).recordSelfConsent(ethers.utils.id("other"), vault.address, 1), "InvalidTerms()");
    await expectRevert(verifier.connect(user).recordSelfConsent(termsHash, ethers.constants.AddressZero, 1), "ZeroAddressNotAllowed()");
    await verifier.connect(owner).setActiveTerms("v2027-01", ethers.utils.id("terms v2027-01"));
    await expectRevert(verifier.connect(user).recordSelfConsent(termsHash, vault.address, 1), "InvalidTerms()");
  });

  it("is append-only and per caller", async function () {
    const { owner, user, vault, verifier, termsHash } = await loadFixture(deployFixture);
    await verifier.connect(owner).setActiveTerms("v2026-11", termsHash);
    await verifier.connect(user).recordSelfConsent(termsHash, vault.address, 1);
    await verifier.connect(user).recordSelfConsent(termsHash, vault.address, 2);
    assert.equal((await verifier.getUserSelfConsentCount(user.address)).toString(), "2");
    assert.equal((await verifier.getUserSelfConsentCount(owner.address)).toString(), "0");
  });
});
