/**
 * TransferEOALegacyRouter's initializer cascade after the 2026-11 train.
 *
 * The ungated initializeV2 (reinitializer 3) and initializeV3 (reinitializer
 * 4) are gone from the implementation: the upgrade batch runs initializeV4
 * (reinitializer 5, UpgradeTimelock only) at once, after which they could
 * never run again. Covered here: a fresh proxy, and proxies that start from
 * the live mainnet bytecode at counter 3 (Sepolia today) and 4 (mainnet
 * today), upgraded through hardhat-deploy's ProxyAdmin.
 *
 * Uses node:assert + a custom reverted-with helper so we don't depend on
 * hardhat-chai-matchers (which has ethers-v5/v6 `isAddressable` incompat).
 */
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";

import { deployProxy } from "./utils/proxy";
import { expectRevert } from "./fixtures/eoaTrain";

const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";
const ZERO = ethers.constants.AddressZero;

// ERC-7201 namespaced storage slot for OpenZeppelin Initializable v5
const INITIALIZABLE_STORAGE_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "live", "mainnet-implementations.json"), "utf-8"));
const ProxyAdminArt = require("hardhat-deploy/extendedArtifacts/ProxyAdmin.json");
const ProxyArt = require("hardhat-deploy/extendedArtifacts/OptimizedTransparentUpgradeableProxy.json");

async function readInitializedVersion(proxyAddr: string): Promise<number> {
  const packed = await ethers.provider.getStorageAt(proxyAddr, INITIALIZABLE_STORAGE_SLOT);
  return Number(BigInt("0x" + packed.slice(-16)));
}

describe("TransferEOALegacyRouter — initializer cascade", function () {
  this.timeout(150000);

  async function deps() {
    const [treasury, dev, timelock, safe, other] = await ethers.getSigners();
    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");
    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const payment = await (await ethers.getContractFactory("Payment")).deploy();
    const initArgs = [legacyDeployer.address, premiumSetting.address, verifierTerm.address, payment.address, router, weth];
    return { treasury, dev, timelock, safe, other, payment, initArgs };
  }

  async function freshFixture() {
    const d = await deps();
    const proxy = await deployProxy("TransferEOALegacyRouter", d.initArgs, "initialize", undefined, [d.timelock.address]);
    return { ...d, proxy };
  }

  /** A proxy on the live mainnet implementation, as the batch finds it. */
  async function liveFixture() {
    const d = await deps();
    const liveImpl = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [liveImpl, LIVE.implementations.TransferEOALegacyRouter.code]);
    const proxyAdmin = await new ethers.ContractFactory(ProxyAdminArt.abi, ProxyAdminArt.bytecode, d.treasury).deploy(d.timelock.address);
    const R = await ethers.getContractFactory("TransferEOALegacyRouter");
    const p = await new ethers.ContractFactory(ProxyArt.abi, ProxyArt.bytecode, d.treasury).deploy(
      liveImpl,
      proxyAdmin.address,
      R.interface.encodeFunctionData("initialize", d.initArgs)
    );
    const old = new ethers.Contract(p.address, ["function initializeV2(address)", "function initializeV3(address)"], d.dev);
    const newImpl = await R.deploy(d.timelock.address);
    const proxy = R.attach(p.address);
    const upgrade = () => proxyAdmin.connect(d.timelock).upgrade(p.address, newImpl.address);
    return { ...d, proxy, old, upgrade };
  }

  it("a freshly deployed proxy is at _initialized=1 after initialize()", async function () {
    const { proxy } = await loadFixture(freshFixture);
    assert.equal(await readInitializedVersion(proxy.address), 1);
  });

  it("initializeV2 and initializeV3 are gone from the implementation", async function () {
    const { proxy, dev } = await loadFixture(freshFixture);
    assert.equal(proxy.interface.fragments.some((f: any) => f.name === "initializeV2" || f.name === "initializeV3"), false);
    const old = new ethers.Contract(proxy.address, ["function initializeV2(address)", "function initializeV3(address)"], dev);
    await expectRevert(old.initializeV2(dev.address), "");
    await expectRevert(old.initializeV3(dev.address), "");
    assert.equal(await readInitializedVersion(proxy.address), 1);
  });

  describe("initializeV4 (reinitializer(5), UpgradeTimelock only)", function () {
    it("fresh proxy: 1 → 5, the code admin is set, only the timelock may call, once", async function () {
      const { proxy, dev, timelock, safe } = await loadFixture(freshFixture);
      await expectRevert(proxy.connect(dev).initializeV4(safe.address, ZERO), "NotUpgradeTimelock()");
      await expectRevert(proxy.connect(timelock).initializeV4(ZERO, ZERO), "InvalidInitialization()");
      await proxy.connect(timelock).initializeV4(safe.address, ZERO);
      assert.equal(await readInitializedVersion(proxy.address), 5);
      await proxy.connect(safe).setCreatePaused(true);
      await expectRevert(proxy.connect(timelock).initializeV4(safe.address, ZERO), "InvalidInitialization()");
    });

    it("mainnet path: live code at counter 4 (after initializeV3), upgraded, then initializeV4", async function () {
      const { proxy, old, upgrade, dev, timelock, safe } = await loadFixture(liveFixture);
      await old.initializeV3(dev.address);
      assert.equal(await readInitializedVersion(proxy.address), 4);
      await upgrade();
      await proxy.connect(timelock).initializeV4(safe.address, ZERO);
      assert.equal(await readInitializedVersion(proxy.address), 5);
      await expectRevert(proxy.connect(dev).setCreatePaused(true), "NotCodeAdmin()");
      await proxy.connect(safe).setCreatePaused(true);
    });

    it("Sepolia path: live code at counter 3 (after initializeV2), upgraded, then initializeV4 with the Payment repoint", async function () {
      const { proxy, old, upgrade, dev, timelock, safe, payment } = await loadFixture(liveFixture);
      await old.initializeV2(dev.address);
      assert.equal(await readInitializedVersion(proxy.address), 3);
      await upgrade();
      const other = await (await ethers.getContractFactory("Payment")).deploy();
      await proxy.connect(timelock).initializeV4(safe.address, other.address);
      assert.equal(await readInitializedVersion(proxy.address), 5);
      assert.equal(await proxy.paymentContract(), other.address);
      assert.notEqual(other.address, payment.address);
    });

    it("before the upgrade nobody can reach initializeV4; after it, nobody but the timelock", async function () {
      const { proxy, old, upgrade, dev, other } = await loadFixture(liveFixture);
      await old.initializeV3(dev.address);
      await expectRevert(proxy.connect(other).initializeV4(other.address, ZERO), "");
      await upgrade();
      await expectRevert(proxy.connect(other).initializeV4(other.address, ZERO), "NotUpgradeTimelock()");
    });
  });
});
