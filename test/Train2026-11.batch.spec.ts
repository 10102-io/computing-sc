import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";
import * as fs from "fs";
import * as path from "path";

import { increase } from "./utils/time";
import { DAY, PERMIT2_ADDRESS, createLegacyV2, expectRevert, signPermitBatch } from "./fixtures/eoaTrain";
import { wireRouters } from "./fixtures/wiring";
import { deployProxy } from "./utils/proxy";

// Rehearsal of the wave A timelock batch (docs/plans/train-2026-11.md,
// "Wave A runbook") with the production proxy stack: hardhat-deploy's
// ProxyAdmin and OptimizedTransparentUpgradeableProxy, a real UpgradeTimelock
// (Safe as proposer, open executor), and the five proxies starting from the
// runtime bytecode that is live on mainnet today (test/fixtures/live).

const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "live", "mainnet-implementations.json"), "utf-8"));
const ProxyAdminArt = require("hardhat-deploy/extendedArtifacts/ProxyAdmin.json");
const ProxyArt = require("hardhat-deploy/extendedArtifacts/OptimizedTransparentUpgradeableProxy.json");
const ZERO32 = "0x" + "00".repeat(32);
const DELAY = 300;

describe("Train 2026-11 — wave A batch through the UpgradeTimelock, from live bytecode", function () {
  this.timeout(300000);

  async function liveImpl(name: string): Promise<string> {
    const addr = ethers.Wallet.createRandom().address;
    await ethers.provider.send("hardhat_setCode", [addr, LIVE.implementations[name].code]);
    return addr;
  }

  async function fixture() {
    const [treasury, dev, safe, owner, bene, attacker, attestor, guardian] = await ethers.getSigners();

    const mockArtifact = await (await import("hardhat")).artifacts.readArtifact("MockPermit2");
    await ethers.provider.send("hardhat_setCode", [PERMIT2_ADDRESS, mockArtifact.deployedBytecode]);
    const permit2 = await ethers.getContractAt("MockPermit2", PERMIT2_ADDRESS);

    const timelock = await (await ethers.getContractFactory("UpgradeTimelock")).deploy(DELAY, [safe.address], [ethers.constants.AddressZero]);
    const CANCELLER = await timelock.CANCELLER_ROLE();
    await timelock.connect(safe).schedule(
      timelock.address, 0, timelock.interface.encodeFunctionData("grantRole", [CANCELLER, guardian.address]), ZERO32, ZERO32, DELAY
    );
    await increase(DELAY);
    await timelock.execute(timelock.address, 0, timelock.interface.encodeFunctionData("grantRole", [CANCELLER, guardian.address]), ZERO32, ZERO32);

    const proxyAdmin = await new ethers.ContractFactory(ProxyAdminArt.abi, ProxyAdminArt.bytecode, treasury).deploy(timelock.address);
    const proxyFactory = new ethers.ContractFactory(ProxyArt.abi, ProxyArt.bytecode, treasury);
    const proxied = async (name: string, iface: string, initData: string) => {
      const p = await proxyFactory.deploy(await liveImpl(name), proxyAdmin.address, initData);
      return ethers.getContractAt(iface, p.address);
    };

    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdc = await ERC20.deploy("USDC", "USDC", 6);
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const weth = await (await ethers.getContractFactory("MockWETH9")).deploy();
    const uni = await (await ethers.getContractFactory("MockUniswapV2Router")).deploy(weth.address);
    const payment = await (await ethers.getContractFactory("Payment")).deploy();
    await payment.grantRole(await payment.OPERATOR(), treasury.address);
    await payment.connect(treasury).setClaimFee(25, true);

    const PS = await ethers.getContractFactory("PremiumSetting");
    const premiumSetting = await proxied("PremiumSetting", "PremiumSetting", PS.interface.encodeFunctionData("initialize"));
    await premiumSetting.connect(treasury).transferOwnership(dev.address);
    const PR = await ethers.getContractFactory("PremiumRegistry");
    const premiumRegistry = await proxied(
      "PremiumRegistry",
      "PremiumRegistry",
      PR.interface.encodeFunctionData("initialize", [usdt.address, usdc.address, uni.address, uni.address, uni.address, premiumSetting.address, payment.address])
    );
    const V = await ethers.getContractFactory("EIP712LegacyVerifier");
    const verifierTerm = await proxied("EIP712LegacyVerifier", "EIP712LegacyVerifier", V.interface.encodeFunctionData("initialize", [dev.address]));
    const TLR = await ethers.getContractFactory("TimeLockRouter");
    const timeLockRouter = await proxied("TimeLockRouter", "TimeLockRouter", TLR.interface.encodeFunctionData("initialize", [safe.address]));
    const legacyDeployer = await deployProxy("LegacyDeployer");
    const R = await ethers.getContractFactory("TransferEOALegacyRouter");
    const router = await proxied(
      "TransferEOALegacyRouter",
      "TransferEOALegacyRouter",
      R.interface.encodeFunctionData("initialize", [legacyDeployer.address, premiumSetting.address, verifierTerm.address, payment.address, uni.address, weth.address])
    );
    await router.connect(dev).initializeV3(dev.address); // mainnet: counter 4, maintainer EOA as code admin
    const multisigLegacyRouter = await deployProxy("MultisigLegacyRouter", [legacyDeployer.address, premiumSetting.address, verifierTerm.address]);
    await wireRouters({
      admin: dev,
      legacyDeployerAdmin: treasury,
      premiumSetting,
      premiumRegistry,
      legacyDeployer,
      verifierTerm,
      transferEOALegacyRouter: router,
      multisigLegacyRouter,
    });

    // Today's wiring, done the way it is done today: the code admin key.
    const cloneA = await (await ethers.getContractFactory("TransferEOALegacy")).deploy();
    const vaultV1 = await (await ethers.getContractFactory("LegacyPullVault")).deploy(router.address, cloneA.address);
    await router.connect(dev).setLegacyImplementation(cloneA.address);
    await router.connect(dev).setPullVault(vaultV1.address);
    await router.connect(dev).setActivityAttestor(attestor.address);
    await verifierTerm.connect(dev).setActiveTerms("v2026-11", ethers.utils.id("terms"));
    await premiumRegistry.connect(treasury).createPlans([365 * DAY], [9900], ["Annual"], [""], [""]);

    await usdc.mint(owner.address, 1_000_000_000);
    await usdc.connect(owner).approve(PERMIT2_ADDRESS, ethers.constants.MaxUint256);
    const network = await ethers.provider.getNetwork();
    const permit2Domain = { name: "Permit2", chainId: network.chainId, verifyingContract: PERMIT2_ADDRESS };
    const bundle = await signPermitBatch(owner, permit2Domain, [usdc.address], vaultV1.address);
    const l1 = await createLegacyV2(router, owner, [{ user: bene.address, percent: 1000000 }], { bundle });

    // The train's new code: implementations deployed, nothing wired yet.
    const newImpls = {
      TransferEOALegacyRouter: (await R.deploy(timelock.address)).address,
      TimeLockRouter: (await TLR.deploy()).address,
      PremiumRegistry: (await PR.deploy()).address,
      PremiumSetting: (await PS.deploy()).address,
      EIP712LegacyVerifier: (await V.deploy()).address,
    };
    const cloneB = await (await ethers.getContractFactory("TransferEOALegacy")).deploy();
    const vaultV2 = await (await ethers.getContractFactory("LegacyPullVaultV2")).deploy(router.address, timelock.address, cloneB.address);

    const up = (proxy: string, impl: string) => ({ target: proxyAdmin.address, data: proxyAdmin.interface.encodeFunctionData("upgrade", [proxy, impl]) });
    const items = [
      up(router.address, newImpls.TransferEOALegacyRouter),
      { target: router.address, data: R.interface.encodeFunctionData("initializeV4", [safe.address, ethers.constants.AddressZero]) },
      { target: router.address, data: R.interface.encodeFunctionData("setLegacyImplementation", [cloneB.address]) },
      { target: router.address, data: R.interface.encodeFunctionData("setPullVault", [vaultV2.address]) },
      up(timeLockRouter.address, newImpls.TimeLockRouter),
      up(premiumRegistry.address, newImpls.PremiumRegistry),
      up(premiumSetting.address, newImpls.PremiumSetting),
      up(verifierTerm.address, newImpls.EIP712LegacyVerifier),
    ];
    const salt = ethers.utils.id("train-2026-11-wave-a");
    const batch = [items.map((i) => i.target), items.map(() => 0), items.map((i) => i.data), ZERO32, salt] as const;

    return {
      treasury, dev, safe, owner, bene, attacker, attestor, guardian, timelock, proxyAdmin, router, timeLockRouter,
      premiumRegistry, premiumSetting, verifierTerm, cloneA, cloneB, vaultV1, vaultV2, usdc, permit2, permit2Domain,
      l1, batch, newImpls,
    };
  }

  it("the Safe schedules, nothing runs before the delay, anyone executes, the guardian could cancel", async function () {
    const { safe, attacker, guardian, timelock, batch } = await loadFixture(fixture);
    await expectRevert(timelock.connect(attacker).scheduleBatch(...batch, DELAY), "AccessControlUnauthorizedAccount(address,bytes32)");
    await timelock.connect(safe).scheduleBatch(...batch, DELAY);
    const id = await timelock.hashOperationBatch(...batch);
    await expectRevert(timelock.connect(attacker).executeBatch(...batch), "TimelockUnexpectedOperationState(bytes32,bytes32)");
    assert.equal(await timelock.isOperationPending(id), true);
    void guardian; // cancel is exercised in the next test
    await increase(DELAY);
    await timelock.connect(attacker).executeBatch(...batch);
    assert.equal(await timelock.isOperationDone(id), true);
  });

  it("the guardian's cancel stops the batch", async function () {
    const { safe, attacker, guardian, timelock, batch } = await loadFixture(fixture);
    await timelock.connect(safe).scheduleBatch(...batch, DELAY);
    const id = await timelock.hashOperationBatch(...batch);
    await timelock.connect(guardian).cancel(id);
    await increase(DELAY);
    await expectRevert(timelock.connect(attacker).executeBatch(...batch), "TimelockUnexpectedOperationState(bytes32,bytes32)");
  });

  it("after execution: state survives, levers are timelocked, the Safe holds the pause, old legacies keep their vault", async function () {
    const f = await loadFixture(fixture);
    const { dev, safe, owner, bene, attacker, attestor, timelock, proxyAdmin, router, cloneB, vaultV1, vaultV2, usdc, l1, batch, newImpls } = f;

    const before = {
      legacyId: (await router._legacyId()).toString(),
      l1: await router.legacyAddresses(1),
      isCreate: await router.isCreateLegacy(owner.address),
      attestor: await router.activityAttestor(),
      verifier: await router.verifier(),
      plan: (await f.premiumRegistry.premiumPlans(0)).usdPrice.toString(),
      terms: await f.verifierTerm.activeTermsHash(),
      timelockOwner: await f.timeLockRouter.owner(),
    };

    await timelock.connect(safe).scheduleBatch(...batch, DELAY);
    await increase(DELAY);
    await timelock.connect(attacker).executeBatch(...batch);

    for (const [name, proxy] of [
      ["TransferEOALegacyRouter", router.address],
      ["TimeLockRouter", f.timeLockRouter.address],
      ["PremiumRegistry", f.premiumRegistry.address],
      ["PremiumSetting", f.premiumSetting.address],
      ["EIP712LegacyVerifier", f.verifierTerm.address],
    ] as const) {
      assert.equal(await proxyAdmin.getProxyImplementation(proxy), (newImpls as any)[name], `${name} upgraded`);
    }

    // State preserved across all five proxies.
    assert.equal((await router._legacyId()).toString(), before.legacyId);
    assert.equal(await router.legacyAddresses(1), before.l1);
    assert.equal(await router.isCreateLegacy(owner.address), before.isCreate);
    assert.equal(await router.activityAttestor(), before.attestor);
    assert.equal(await router.verifier(), before.verifier);
    assert.equal((await f.premiumRegistry.premiumPlans(0)).usdPrice.toString(), before.plan);
    assert.equal(await f.verifierTerm.activeTermsHash(), before.terms);
    assert.equal(await f.timeLockRouter.owner(), before.timelockOwner);

    // Wiring from the batch.
    assert.equal(await router.legacyImplementation(), cloneB.address);
    assert.equal(await router.pullVault(), vaultV2.address);
    assert.equal(await router.upgradeTimelock(), timelock.address);

    // M-3: the old code admin key can no longer rotate anything; the Safe holds the pause.
    await expectRevert(router.connect(dev).setPullVault(attacker.address), "NotUpgradeTimelock()");
    await expectRevert(router.connect(dev).setCreatePaused(true), "NotCodeAdmin()");
    await router.connect(safe).setCreatePaused(true);
    await router.connect(safe).setCreatePaused(false);

    // The pre-train legacy still claims through the vault it pinned (v1).
    assert.equal(await l1.legacy.pullVault(), vaultV1.address);
    await increase(DAY + 1);
    await router.connect(bene).activeLegacy(l1.legacyId, [usdc.address], false);
    assert((await usdc.balanceOf(bene.address)).gt(990_000_000), "pre-train legacy pulled through vault v1");

    // New creates clone the new implementation and bind in vault v2.
    await usdc.mint(attestor.address, 10_000_000);
    const l2 = await createLegacyV2(router, attestor, [{ user: bene.address, percent: 1000000 }], { maxFeeBps: 25 });
    assert.equal(await l2.legacy.pullVault(), vaultV2.address);
    assert.equal(await vaultV2.boundLegacy(attestor.address), l2.legacy.address);

    // New surfaces answer on the other four proxies.
    assert.equal((await f.premiumRegistry.couponDiscountBps("NOPE")).toString(), "0");
    assert.equal((await f.verifierTerm.getUserSelfConsentCount(owner.address)).toString(), "0");
    const empty = {
      timelockETHSwap: { storageToken: ethers.constants.AddressZero, amountOutMin: 0, deadline: 0 },
      timelockERC20: [], timelockERC721: [], timelockERC1155: [], duration: 0, name: "",
    };
    await expectRevert(f.timeLockRouter.connect(owner).createTimelockUntil(empty, 4102444800), "EmptyTimelock()");
  });

  it("initializeV4 cannot be front-run: it does not exist before the upgrade and only the timelock can call it after", async function () {
    const { safe, attacker, timelock, router, batch } = await loadFixture(fixture);
    await expectRevert(router.connect(attacker).initializeV4(attacker.address, ethers.constants.AddressZero), "");
    await timelock.connect(safe).scheduleBatch(...batch, DELAY);
    await increase(DELAY);
    await timelock.connect(attacker).executeBatch(...batch);
    await expectRevert(router.connect(attacker).initializeV4(attacker.address, ethers.constants.AddressZero), "InvalidInitialization()");
  });
});
