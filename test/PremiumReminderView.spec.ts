import { ethers } from "hardhat";
import assert from "node:assert";

import { deployProxy } from "./utils/proxy";

// Phase B: PremiumReminderView is the stateless on-chain trust-anchor for *when* a time-based
// reminder window is open. It re-expresses PremiumAutomation.checkUpkeep's timing (no dedup —
// the worker owns the sent-ledger). These tests pin the window math per layer + the gates
// (premium / live / armed).
describe("PremiumReminderView — due-window timing (Phase B)", function () {
  this.timeout(120000);

  const ZERO = ethers.constants.AddressZero;
  const AHEAD = 3600; // defaultNotifyAhead used by the view

  // NotifyLib.NotifyType enum values
  const BeforeActivation = 1;
  const BeforeLayer2 = 2;
  const BeforeLayer3 = 3;
  const ReadyToActivate = 4;
  const Layer2ReadyToActivate = 5;
  const Layer3ReadyToActivate = 6;

  async function now() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  }

  async function deployFixture(layer = 1, activatedLayer = 0) {
    const [deployer, registry, router, creator, owner] = await ethers.getSigners();

    const setting = await deployProxy("PremiumSetting", [], "initialize", deployer);
    await setting.connect(deployer).setParams(registry.address, ZERO, router.address, router.address);
    await setting.connect(registry).updatePremiumTime(creator.address, ethers.constants.MaxUint256);

    const Mock = await ethers.getContractFactory("MockPremiumLegacy");
    // LEGACY_TYPE defaults to 3 (EOA) so _armed() is true without a Safe.
    const legacy = await Mock.deploy(creator.address, owner.address, router.address, "L", layer, activatedLayer);

    const View = await ethers.getContractFactory("PremiumReminderView");
    const view = await View.deploy(setting.address, AHEAD);

    return { setting, view, legacy, creator, registry };
  }

  async function due(view: any, legacy: any): Promise<number[]> {
    const r = await view.dueReminders(legacy.address);
    return r.map((x: any) => Number(x));
  }

  it("layer 1, all triggers far in the future → no windows open", async function () {
    const { view, legacy } = await deployFixture(1);
    const t = await now();
    await legacy.setTriggers(t + 100000, t + 200000, t + 300000);
    assert.deepEqual(await due(view, legacy), []);
  });

  it("layer 1, t1 inside the notify-ahead window → BeforeActivation", async function () {
    const { view, legacy } = await deployFixture(1);
    const t = await now();
    // t1 is 1000s away (< AHEAD), t2/t3 far off so no layer-2 window
    await legacy.setTriggers(t + 1000, t + 500000, t + 600000);
    assert.deepEqual(await due(view, legacy), [BeforeActivation]);
  });

  it("layer 1, t1 in the past → ReadyToActivate", async function () {
    const { view, legacy } = await deployFixture(1);
    const t = await now();
    await legacy.setTriggers(t - 10, t + 500000, t + 600000);
    assert.deepEqual(await due(view, legacy), [ReadyToActivate]);
  });

  it("layer 1, t2 inside notify-ahead (and t2 != t1) → BeforeLayer2 (plus BeforeActivation if t1 also near)", async function () {
    const { view, legacy } = await deployFixture(1);
    const t = await now();
    // t2 within AHEAD, t1 far enough that its own window isn't open yet
    await legacy.setTriggers(t + 500000, t + 1000, t + 600000);
    assert.deepEqual(await due(view, legacy), [BeforeLayer2]);
  });

  it("layer 2, t2 in the past → Layer2ReadyToActivate", async function () {
    const { view, legacy } = await deployFixture(2);
    const t = await now();
    await legacy.setTriggers(t - 100000, t - 10, t + 500000);
    assert.deepEqual(await due(view, legacy), [Layer2ReadyToActivate]);
  });

  it("layer 2, t3 inside notify-ahead → BeforeLayer3", async function () {
    const { view, legacy } = await deployFixture(2);
    const t = await now();
    // t2 still in the future so its ready-window isn't open; t3 within AHEAD
    await legacy.setTriggers(t - 100000, t + 500000, t + 1000);
    assert.deepEqual(await due(view, legacy), [BeforeLayer3]);
  });

  it("layer 3 → always Layer3ReadyToActivate", async function () {
    const { view, legacy } = await deployFixture(3);
    const t = await now();
    await legacy.setTriggers(t - 100000, t - 50000, t - 10);
    assert.deepEqual(await due(view, legacy), [Layer3ReadyToActivate]);
  });

  it("non-premium creator → empty regardless of timing", async function () {
    const { view, legacy, setting } = await deployFixture(3);
    const [owner, , , creator] = await ethers.getSigners();
    // resetPremium is onlyOwner; the proxy owner is the deployer (signers[0]).
    await setting.connect(owner).resetPremium(creator.address);
    const t = await now();
    await legacy.setTriggers(t - 100000, t - 50000, t - 10);
    assert.deepEqual(await due(view, legacy), []);
  });

  it("not live → empty regardless of timing", async function () {
    const { view, legacy } = await deployFixture(3);
    await legacy.setLive(false);
    const t = await now();
    await legacy.setTriggers(t - 100000, t - 50000, t - 10);
    assert.deepEqual(await due(view, legacy), []);
  });
});
