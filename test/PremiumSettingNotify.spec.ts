import { ethers } from "hardhat";
import assert from "node:assert";

import { deployProxy } from "./utils/proxy";

// Phase B / Option B (emit-alongside, Deploy 1): the three notify triggers must emit a
// PII-free LegacyEmailNotifyRequested(legacy, creator, layer, notifyType) BEFORE consulting
// premiumSendMail, so the off-chain reminder-worker can drive emails independently of the
// Chainlink-era mail contracts. These tests assert the event fires with the right args even
// when premiumSendMail is unset (the post-cutover state).
describe("PremiumSetting — LegacyEmailNotifyRequested (Phase B notify)", function () {
  this.timeout(120000);

  const ZERO = ethers.constants.AddressZero;
  // NotifyType enum order in PremiumSetting.sol
  const OWNER_RESET = 0;
  const ACTIVATED_MULTISIG = 1;
  const ACTIVATED_TRANSFER = 2;

  // Parse the notify event from a receipt regardless of which contract the tx targeted
  // (the transfer path is triggered via the mock legacy, so the log comes from a different
  // address than the tx target and won't be auto-decoded by receipt.events).
  function findNotify(receipt: any, premiumSetting: any) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== premiumSetting.address.toLowerCase()) continue;
      try {
        const parsed = premiumSetting.interface.parseLog(log);
        if (parsed.name === "LegacyEmailNotifyRequested") return parsed.args;
      } catch {
        // not our event
      }
    }
    return undefined;
  }

  async function deployFixture(legacyLayer = 1, activatedLayer = 1) {
    const [deployer, registry, router, creator, owner] = await ethers.getSigners();

    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", deployer);

    // registry signer plays premiumRegistry so we can mark `creator` premium;
    // router signer plays the EOA + multisig routers so onlyRouter passes.
    await premiumSetting.connect(deployer).setParams(registry.address, ZERO, router.address, router.address);
    await premiumSetting.connect(registry).updatePremiumTime(creator.address, ethers.constants.MaxUint256);

    const Mock = await ethers.getContractFactory("MockPremiumLegacy");
    // mock.router() == router.address so the onlyLegacy modifier accepts the transfer path.
    const legacy = await Mock.deploy(creator.address, owner.address, router.address, "My Legacy", legacyLayer, activatedLayer);

    return { premiumSetting, deployer, registry, router, creator, owner, legacy };
  }

  it("triggerActivationMultisig emits notifyType=ActivatedMultisig with creator + layer", async function () {
    const { premiumSetting, router, creator, legacy } = await deployFixture(2, 0);

    const tx = await premiumSetting.connect(router).triggerActivationMultisig(legacy.address);
    const receipt = await tx.wait();
    const args = findNotify(receipt, premiumSetting);

    assert(args !== undefined, "notify event should be emitted");
    assert.equal(args.legacy.toLowerCase(), legacy.address.toLowerCase());
    assert.equal(args.creator.toLowerCase(), creator.address.toLowerCase());
    assert.equal(Number(args.layer), 2);
    assert.equal(Number(args.notifyType), ACTIVATED_MULTISIG);
  });

  it("triggerOwnerResetReminder emits notifyType=OwnerReset", async function () {
    const { premiumSetting, router, creator, legacy } = await deployFixture(1, 1);

    const tx = await premiumSetting.connect(router).triggerOwnerResetReminder(legacy.address);
    const receipt = await tx.wait();
    const args = findNotify(receipt, premiumSetting);

    assert(args !== undefined, "notify event should be emitted");
    assert.equal(args.legacy.toLowerCase(), legacy.address.toLowerCase());
    assert.equal(args.creator.toLowerCase(), creator.address.toLowerCase());
    assert.equal(Number(args.notifyType), OWNER_RESET);
  });

  it("notifyActivatedTransfer (onlyRouter) emits notifyType=ActivatedTransfer with the activated layer", async function () {
    const { premiumSetting, router, creator, legacy } = await deployFixture(3, 2);

    // End-state: the EOA router calls notifyActivatedTransfer(legacy, activatingBene) via the
    // non-spoofable onlyRouter path (the old onlyLegacy self-call was deleted — M-2′ fix).
    const tx = await premiumSetting.connect(router).notifyActivatedTransfer(legacy.address, creator.address);
    const receipt = await tx.wait();
    const args = findNotify(receipt, premiumSetting);

    assert(args !== undefined, "notify event should be emitted");
    assert.equal(args.legacy.toLowerCase(), legacy.address.toLowerCase());
    assert.equal(args.creator.toLowerCase(), creator.address.toLowerCase());
    assert.equal(Number(args.layer), 2); // activatedLayer
    assert.equal(Number(args.notifyType), ACTIVATED_TRANSFER);
  });

  it("does NOT emit for a non-premium creator", async function () {
    const [deployer, registry, router, , owner, nonPremium] = await ethers.getSigners();

    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", deployer);
    await premiumSetting.connect(deployer).setParams(registry.address, ZERO, router.address, router.address);

    const Mock = await ethers.getContractFactory("MockPremiumLegacy");
    // creator = nonPremium (never given premium time)
    const legacy = await Mock.deploy(nonPremium.address, owner.address, router.address, "No Premium", 1, 1);

    const tx = await premiumSetting.connect(router).triggerActivationMultisig(legacy.address);
    const receipt = await tx.wait();
    const args = findNotify(receipt, premiumSetting);

    assert(args === undefined, "no notify event for non-premium creator");
  });
});
