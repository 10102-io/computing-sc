/**
 * Regression suite for TransferEOALegacyRouter's initializer cascade.
 *
 * In particular covers `initializeV3`, which is the rotation path used on
 * chains whose `_initialized` counter has already advanced past 3 due to a
 * prior reinitialization cycle (mainnet, as of the EIP-1167 upgrade).
 *
 * Uses node:assert + a custom reverted-with helper so we don't depend on
 * hardhat-chai-matchers (which has ethers-v5/v6 `isAddressable` incompat).
 */
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { deployProxy } from "./utils/proxy";

const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

// ERC-7201 namespaced storage slot for OpenZeppelin Initializable v5
const INITIALIZABLE_STORAGE_SLOT =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

async function readInitializedVersion(proxyAddr: string): Promise<number> {
  const packed = await ethers.provider.getStorageAt(proxyAddr, INITIALIZABLE_STORAGE_SLOT);
  const initializedHex = packed.slice(-16); // low 8 bytes
  return Number(BigInt("0x" + initializedHex));
}

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils
    .keccak256(ethers.utils.toUtf8Bytes(signature))
    .slice(0, 10)
    .toLowerCase();
  const blob = (
    (err?.message ?? "") +
    " " +
    JSON.stringify(err ?? "") +
    " " +
    (err?.data ?? "") +
    " " +
    (err?.error?.message ?? "")
  ).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("TransferEOALegacyRouter — initializer cascade", function () {
  this.timeout(150000);

  async function baseFixture() {
    const [treasury, dev, other] = await ethers.getSigners();

    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");
    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", dev);
    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);

    return { treasury, dev, other, transferEOALegacyRouter };
  }

  it("a freshly deployed proxy is at _initialized=1 after initialize()", async function () {
    const { transferEOALegacyRouter } = await loadFixture(baseFixture);
    const v = await readInitializedVersion(transferEOALegacyRouter.address);
    assert.equal(v, 1, `expected _initialized=1, got ${v}`);
  });

  describe("initializeV2 (reinitializer(3))", function () {
    it("sets _codeAdmin and bumps _initialized to 3", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
      const v = await readInitializedVersion(transferEOALegacyRouter.address);
      assert.equal(v, 3, `expected _initialized=3 after initializeV2, got ${v}`);
    });

    it("reverts with InvalidInitialization on zero address", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      try {
        await transferEOALegacyRouter.connect(dev).initializeV2(ethers.constants.AddressZero);
        assert.fail("initializeV2(0) should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"), `unexpected error: ${(err as any)?.message}`);
      }
    });

    it("is not callable twice", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
      try {
        await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
        assert.fail("second initializeV2 should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"), `unexpected error: ${(err as any)?.message}`);
      }
    });
  });

  describe("initializeV3 (reinitializer(4))", function () {
    it("is callable on a fresh proxy directly (bumps 1→4 in one step)", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);

      await transferEOALegacyRouter.connect(dev).initializeV3(dev.address);

      const v = await readInitializedVersion(transferEOALegacyRouter.address);
      assert.equal(v, 4, `expected _initialized=4, got ${v}`);

      // Confirm _codeAdmin was set by exercising an onlyCodeAdmin gate.
      // If V3 wrote the slot correctly, setLegacyImplementation from `dev`
      // must succeed (any non-zero impl is accepted).
      const fakeImpl = "0x0000000000000000000000000000000000000001";
      await transferEOALegacyRouter.connect(dev).setLegacyImplementation(fakeImpl);
      const impl = await transferEOALegacyRouter.legacyImplementation();
      assert.equal(impl.toLowerCase(), fakeImpl.toLowerCase());
    });

    it("is still callable AFTER initializeV2 (mainnet-like scenario)", async function () {
      const { dev, other, transferEOALegacyRouter } = await loadFixture(baseFixture);

      // Simulate the mainnet starting state: V2 already ran, _initialized=3,
      // _codeAdmin set to a wallet we do NOT control (represented by `other`).
      await transferEOALegacyRouter.connect(dev).initializeV2(other.address);
      assert.equal(await readInitializedVersion(transferEOALegacyRouter.address), 3);

      // Confirm V2 is no longer callable (the classic "rotation unavailable" state)
      try {
        await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
        assert.fail("initializeV2 after V2 should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"));
      }

      // Rotation via initializeV3 is the escape hatch. It must work exactly once.
      await transferEOALegacyRouter.connect(dev).initializeV3(dev.address);
      assert.equal(await readInitializedVersion(transferEOALegacyRouter.address), 4);

      // And `dev` must now be _codeAdmin, while `other` must NOT be.
      const fakeImpl = "0x0000000000000000000000000000000000000002";
      await transferEOALegacyRouter.connect(dev).setLegacyImplementation(fakeImpl);
      assert.equal(
        (await transferEOALegacyRouter.legacyImplementation()).toLowerCase(),
        fakeImpl.toLowerCase()
      );
      try {
        await transferEOALegacyRouter
          .connect(other)
          .setLegacyImplementation("0x0000000000000000000000000000000000000003");
        assert.fail("setLegacyImplementation from previous _codeAdmin should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "NotCodeAdmin()"), `unexpected error: ${(err as any)?.message}`);
      }
    });

    it("reverts with InvalidInitialization on zero address", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      try {
        await transferEOALegacyRouter.connect(dev).initializeV3(ethers.constants.AddressZero);
        assert.fail("initializeV3(0) should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"));
      }
    });

    it("is not callable twice", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      await transferEOALegacyRouter.connect(dev).initializeV3(dev.address);
      try {
        await transferEOALegacyRouter.connect(dev).initializeV3(dev.address);
        assert.fail("second initializeV3 should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"));
      }
    });

    it("blocks further reinitialization (no V4 exists — _initialized=4 is terminal for the current code)", async function () {
      const { dev, transferEOALegacyRouter } = await loadFixture(baseFixture);
      await transferEOALegacyRouter.connect(dev).initializeV3(dev.address);
      // initializeV2 (reinitializer(3)) must also be blocked post-V3
      try {
        await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
        assert.fail("initializeV2 after V3 should have reverted");
      } catch (err) {
        assert.ok(revertedWith(err, "InvalidInitialization()"));
      }
    });
  });
});
