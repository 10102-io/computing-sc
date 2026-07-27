import { ethers, artifacts } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
import { wireRouters } from "./fixtures/wiring";

// Create-flow v2 §12c — tx-based consent + consent parity + create pause.
//
// Consent gets a second modality alongside the signed message: when the
// consenting party IS the tx signer (EOA create with the in-form checkbox,
// gift-timelock create), the router records "msg.sender accepted the active
// terms" on the verifier — the tx signature is the attribution, no extra
// wallet popup. Gift timelocks (third-party claimable → estate exposure
// comparable to legacies, deferred item `timelock-consent-parity`) now
// record consent on create. Both routers also gain a create-only circuit
// breaker: exits (claims, withdrawals, deletes, unlocks) are NEVER pausable.

const uniRouter = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const TAG = "v2026-07";
const TERMS_HASH = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("full ToS document text v2026-07"));
const ZERO32 = ethers.constants.HashZero;

const EMPTY_BUNDLE = {
  permitBatch: { details: [], spender: ethers.constants.AddressZero, sigDeadline: 0 },
  signature: "0x",
};
const NO_SWAP = { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 };

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

async function expectRevert(p: Promise<any>, sig: string) {
  let caught: any = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert(caught, `expected revert ${sig}`);
  assert(revertedWith(caught, sig), `expected ${sig}, got: ${caught?.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────

describe("EIP712LegacyVerifier — tx-based consent registry", function () {
  this.timeout(150000);

  async function fixture() {
    const [owner, recorder, user, mallory] = await ethers.getSigners();
    const verifier = await deployProxy("EIP712LegacyVerifier", [owner.address], "initialize", owner);
    // recordConsent is gated on `consentRecorders`, not the legacy onlyRouter
    // trio — an EOA recorder lets us exercise the registry in isolation.
    return { verifier, owner, recorder, user, mallory };
  }

  it("owner authorizes and revokes recorders; non-owner cannot", async () => {
    const { verifier, owner, recorder, mallory } = await loadFixture(fixture);
    const receipt = await (await verifier.connect(owner).setConsentRecorder(recorder.address, true)).wait();
    const evt = receipt.events?.find((e: any) => e.event === "ConsentRecorderSet");
    assert(evt && evt.args.recorder === recorder.address && evt.args.allowed === true);
    assert.equal(await verifier.consentRecorders(recorder.address), true);

    await verifier.connect(owner).setConsentRecorder(recorder.address, false);
    assert.equal(await verifier.consentRecorders(recorder.address), false);

    let caught: any = null;
    try {
      await verifier.connect(mallory).setConsentRecorder(mallory.address, true);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected onlyOwner revert");
  });

  it("rejects zero-address recorder", async () => {
    const { verifier, owner } = await loadFixture(fixture);
    await expectRevert(
      verifier.connect(owner).setConsentRecorder(ethers.constants.AddressZero, true),
      "ZeroAddressNotAllowed()"
    );
  });

  it("rejects recordConsent from unauthorized callers", async () => {
    const { verifier, owner, mallory, user } = await loadFixture(fixture);
    await verifier.connect(owner).setActiveTerms(TAG, TERMS_HASH);
    await expectRevert(verifier.connect(mallory).recordConsent(user.address, 1), "UnauthorizedCaller()");
  });

  it("rejects recordConsent when no active terms are published", async () => {
    const { verifier, owner, recorder, user } = await loadFixture(fixture);
    await verifier.connect(owner).setConsentRecorder(recorder.address, true);
    await expectRevert(verifier.connect(recorder).recordConsent(user.address, 1), "NoActiveTerms()");
  });

  it("records consent bound to the active terms and reconstructs the version after rotation", async () => {
    const { verifier, owner, recorder, user } = await loadFixture(fixture);
    await verifier.connect(owner).setConsentRecorder(recorder.address, true);
    await verifier.connect(owner).setActiveTerms(TAG, TERMS_HASH);

    const receipt = await (await verifier.connect(recorder).recordConsent(user.address, 42)).wait();
    const evt = receipt.events?.find((e: any) => e.event === "ConsentRecorded");
    assert(evt, "expected ConsentRecorded event");
    assert.equal(evt.args.user, user.address);
    assert.equal(evt.args.termsHash, TERMS_HASH);
    assert.equal(evt.args.recorder, recorder.address);
    assert.equal(evt.args.refId.toString(), "42");
    assert.equal(evt.args.termsVersion, TAG);

    // Rotate terms — the stored record must still resolve to the ORIGINAL tag.
    const HASH2 = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("newer terms"));
    await verifier.connect(owner).setActiveTerms("v2027-01", HASH2);

    assert.equal((await verifier.getUserConsentCount(user.address)).toString(), "1");
    const rec = await verifier.getUserConsent(user.address, 0);
    assert.equal(rec.termsHash, TERMS_HASH);
    assert.equal(rec.termsVersion, TAG);
    assert.equal(rec.recorder, recorder.address);
    assert.equal(rec.refId.toString(), "42");
    assert(rec.timestamp.gt(0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("TransferEOALegacyRouter — tx-based consent + create pause", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, owner, bene, mallory] = await ethers.getSigners();

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

    return { treasury, dev, owner, bene, mallory, transferEOALegacyRouter, verifierTerm, usdt };
  }

  const zeroDist = { user: ethers.constants.AddressZero, percent: 0 };
  const extraConfig = { lackOfOutgoingTxRange: 86400, delayLayer2: 0, delayLayer3: 0 };

  function createV2(router: any, signer: any, bene: string, sigTs: number, sig: string) {
    return router
      .connect(signer)
      .createLegacyV2([{ user: bene, percent: 1000000 }], extraConfig, zeroDist, zeroDist, EMPTY_BUNDLE, sigTs, sig);
  }

  it("empty agreement signature = tx-based consent: recorded on the verifier, bound to active terms", async () => {
    const { dev, owner, bene, transferEOALegacyRouter, verifierTerm } = await loadFixture(deployFixture);
    await verifierTerm.connect(dev).setActiveTerms(TAG, TERMS_HASH);
    await verifierTerm.connect(dev).setConsentRecorder(transferEOALegacyRouter.address, true);

    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    await createV2(transferEOALegacyRouter, owner, bene.address, 0, "0x");

    assert.equal((await verifierTerm.getUserConsentCount(owner.address)).toString(), "1");
    const rec = await verifierTerm.getUserConsent(owner.address, 0);
    assert.equal(rec.termsHash, TERMS_HASH);
    assert.equal(rec.termsVersion, TAG);
    assert.equal(rec.recorder, transferEOALegacyRouter.address);
    // refId is the legacy address as uint160 — the same id scheme LegacySigned uses.
    assert.equal(rec.refId.toString(), ethers.BigNumber.from(predicted).toString());
    // No signed-message record was created for this consent.
    assert.equal((await verifierTerm.getUserLegacyCount(owner.address)).toString(), "0");
  });

  it("tx-based consent reverts when the router is not an authorized recorder", async () => {
    const { dev, owner, bene, transferEOALegacyRouter, verifierTerm } = await loadFixture(deployFixture);
    await verifierTerm.connect(dev).setActiveTerms(TAG, TERMS_HASH);
    await expectRevert(createV2(transferEOALegacyRouter, owner, bene.address, 0, "0x"), "UnauthorizedCaller()");
  });

  it("tx-based consent reverts when no active terms are published (consent must bind to a document)", async () => {
    const { dev, owner, bene, transferEOALegacyRouter, verifierTerm } = await loadFixture(deployFixture);
    await verifierTerm.connect(dev).setConsentRecorder(transferEOALegacyRouter.address, true);
    await expectRevert(createV2(transferEOALegacyRouter, owner, bene.address, 0, "0x"), "NoActiveTerms()");
  });

  it("signed-message path still works unchanged (regression)", async () => {
    const { owner, bene, transferEOALegacyRouter, verifierTerm } = await loadFixture(deployFixture);
    const ts = await currentTime();
    const sig = await owner.signMessage(await genMessage(ts));
    await createV2(transferEOALegacyRouter, owner, bene.address, ts, sig);
    assert.equal((await verifierTerm.getUserLegacyCount(owner.address)).toString(), "1");
    assert.equal((await verifierTerm.getUserConsentCount(owner.address)).toString(), "0");
  });

  it("create pause blocks creates, is codeAdmin-gated, and never blocks delete or claim", async () => {
    const { dev, owner, bene, mallory, transferEOALegacyRouter, verifierTerm, usdt } =
      await loadFixture(deployFixture);
    await verifierTerm.connect(dev).setActiveTerms(TAG, TERMS_HASH);
    await verifierTerm.connect(dev).setConsentRecorder(transferEOALegacyRouter.address, true);

    // A live legacy created before the pause, with claimable funds.
    await usdt.mint(owner.address, 1_000_000);
    const predicted: string = await transferEOALegacyRouter.getNextLegacyAddress(owner.address);
    await createV2(transferEOALegacyRouter, owner, bene.address, 0, "0x");
    await usdt.connect(owner).approve(predicted, ethers.constants.MaxUint256);
    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);
    const legacyId = (await legacy.getLegacyInfo())[0];

    // Only the code admin can pause.
    await expectRevert(transferEOALegacyRouter.connect(mallory).setCreatePaused(true), "NotCodeAdmin()");
    const receipt = await (await transferEOALegacyRouter.connect(dev).setCreatePaused(true)).wait();
    assert(receipt.events?.some((e: any) => e.event === "CreatePauseSet"));
    assert.equal(await transferEOALegacyRouter.createPaused(), true);

    // Creates blocked (both consent modalities go through the same core).
    await expectRevert(createV2(transferEOALegacyRouter, mallory, bene.address, 0, "0x"), "CreationPaused()");

    // Exits stay live while paused: the beneficiary claim works.
    await increase(86400 + 1);
    await transferEOALegacyRouter.connect(bene).activeLegacy(legacyId, [usdt.address], false);
    assert.equal((await usdt.balanceOf(bene.address)).toString(), "1000000");

    // Unpause restores creation.
    await transferEOALegacyRouter.connect(dev).setCreatePaused(false);
    await createV2(transferEOALegacyRouter, mallory, bene.address, 0, "0x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("TimeLockRouter — gift consent parity + create pause", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [admin, user, recipient, mallory] = await ethers.getSigners();

    const router = await deployProxy("TimeLockRouter", [admin.address], "initialize", admin);
    const tlERC20 = await deployProxy("TimelockERC20", [admin.address, router.address], "initialize", admin);
    const tlERC721 = await deployProxy("TimelockERC721", [admin.address, router.address], "initialize", admin);
    const tlERC1155 = await deployProxy("TimelockERC1155", [admin.address, router.address], "initialize", admin);
    await router.connect(admin).setTimelock(tlERC20.address, tlERC721.address, tlERC1155.address);

    const verifier = await deployProxy("EIP712LegacyVerifier", [admin.address], "initialize", admin);

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    await usdt.mint(user.address, 1_000_000_000);
    await usdt.connect(user).approve(router.address, ethers.constants.MaxUint256);

    return { admin, user, recipient, mallory, router, tlERC20, verifier, usdt };
  }

  function erc20Leg(token: string, amount: number) {
    return [{ tokenAddress: token, amount }];
  }
  function gift(token: string, amount: number, recipient: string, duration = 86400) {
    return {
      timelockETHSwap: NO_SWAP,
      timelockERC20: erc20Leg(token, amount),
      timelockERC721: [],
      timelockERC1155: [],
      duration,
      recipient,
      name: "gift",
      giftName: "for you",
    };
  }
  function regular(token: string, amount: number, duration = 86400) {
    return { timelockETHSwap: NO_SWAP, timelockERC20: erc20Leg(token, amount), timelockERC721: [], timelockERC1155: [], duration, name: "tl" };
  }
  function soft(token: string, amount: number, bufferTime = 3600) {
    return { timelockETHSwap: NO_SWAP, timelockERC20: erc20Leg(token, amount), timelockERC721: [], timelockERC1155: [], bufferTime, name: "tl" };
  }

  it("setConsentVerifier is owner-gated and emits", async () => {
    const { admin, mallory, router, verifier } = await loadFixture(deployFixture);
    let caught: any = null;
    try {
      await router.connect(mallory).setConsentVerifier(verifier.address);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected onlyOwner revert");

    const receipt = await (await router.connect(admin).setConsentVerifier(verifier.address)).wait();
    assert(receipt.events?.some((e: any) => e.event === "ConsentVerifierSet"));
    assert.equal(await router.consentVerifier(), verifier.address);
  });

  it("gift create records the creator's consent bound to the new timelock id", async () => {
    const { admin, user, recipient, router, verifier, usdt } = await loadFixture(deployFixture);
    await verifier.connect(admin).setActiveTerms(TAG, TERMS_HASH);
    await verifier.connect(admin).setConsentRecorder(router.address, true);
    await router.connect(admin).setConsentVerifier(verifier.address);

    await router.connect(user).createTimelockedGift(gift(usdt.address, 100_000_000, recipient.address));

    assert.equal((await verifier.getUserConsentCount(user.address)).toString(), "1");
    const rec = await verifier.getUserConsent(user.address, 0);
    assert.equal(rec.termsHash, TERMS_HASH);
    assert.equal(rec.termsVersion, TAG);
    assert.equal(rec.recorder, router.address);
    assert.equal(rec.refId.toString(), (await router.timelockCounter()).toString());
  });

  it("self-claim regular and soft creates do NOT record consent", async () => {
    const { admin, user, router, verifier, usdt } = await loadFixture(deployFixture);
    await verifier.connect(admin).setActiveTerms(TAG, TERMS_HASH);
    await verifier.connect(admin).setConsentRecorder(router.address, true);
    await router.connect(admin).setConsentVerifier(verifier.address);

    await router.connect(user).createTimelock(regular(usdt.address, 10_000_000));
    await router.connect(user).createSoftTimelock(soft(usdt.address, 10_000_000));

    assert.equal((await verifier.getUserConsentCount(user.address)).toString(), "0");
  });

  it("gift create works without a consent verifier configured (no recording)", async () => {
    const { user, recipient, router, verifier, usdt } = await loadFixture(deployFixture);
    await router.connect(user).createTimelockedGift(gift(usdt.address, 100_000_000, recipient.address));
    assert.equal((await verifier.getUserConsentCount(user.address)).toString(), "0");
  });

  it("gift create reverts if the verifier is wired but the router is not authorized (fail-closed)", async () => {
    const { admin, user, recipient, router, verifier, usdt } = await loadFixture(deployFixture);
    await verifier.connect(admin).setActiveTerms(TAG, TERMS_HASH);
    await router.connect(admin).setConsentVerifier(verifier.address);
    await expectRevert(
      router.connect(user).createTimelockedGift(gift(usdt.address, 100_000_000, recipient.address)),
      "UnauthorizedCaller()"
    );
  });

  it("create pause blocks all create paths, is owner-gated, and never blocks withdrawal", async () => {
    const { admin, user, recipient, mallory, router, usdt } = await loadFixture(deployFixture);

    // Lock some funds before pausing.
    await router.connect(user).createTimelock(regular(usdt.address, 100_000_000));
    const lockedId = await router.timelockCounter();

    let caught: any = null;
    try {
      await router.connect(mallory).setCreatePaused(true);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected onlyOwner revert");

    const receipt = await (await router.connect(admin).setCreatePaused(true)).wait();
    assert(receipt.events?.some((e: any) => e.event === "CreatePauseSet"));
    assert.equal(await router.createPaused(), true);

    await expectRevert(router.connect(user).createTimelock(regular(usdt.address, 1_000_000)), "CreationPaused()");
    await expectRevert(router.connect(user).createSoftTimelock(soft(usdt.address, 1_000_000)), "CreationPaused()");
    await expectRevert(
      router.connect(user).createTimelockedGift(gift(usdt.address, 1_000_000, recipient.address)),
      "CreationPaused()"
    );
    await expectRevert(
      router.connect(user).createTimelockWithPermit2(regular(usdt.address, 1_000_000), EMPTY_BUNDLE),
      "CreationPaused()"
    );

    // Withdrawals stay live while paused.
    await increase(86400 + 1);
    const before = await usdt.balanceOf(user.address);
    await router.connect(user)["withdraw(uint256,bool)"](lockedId, true);
    assert((await usdt.balanceOf(user.address)).gt(before), "withdraw must work while create is paused");

    // Unpause restores creation.
    await router.connect(admin).setCreatePaused(false);
    await router.connect(user).createTimelock(regular(usdt.address, 1_000_000));
  });
});
