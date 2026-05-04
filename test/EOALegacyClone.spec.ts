import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { strict as assert } from "node:assert";

import { currentTime, increase } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";

// Dummy Uniswap router + WETH. autoSwap/unswap/activeLegacyAndUnswap are not
// exercised here; the lifecycle we assert on goes through the non-swap paths.
const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

// EIP-1167 minimal proxy runtime layout:
//   363d3d373d3d3d363d73 <20-byte impl> 5af43d82803e903d91602b57fd5bf3
// Total = 45 bytes.
const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function revertedWith(err: any, signature: string): boolean {
  const selector = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(signature)).slice(0, 10).toLowerCase();
  const blob = ((err?.message ?? "") + " " + JSON.stringify(err ?? "") + " " + (err?.data ?? "") + " " + (err?.error?.message ?? "")).toLowerCase();
  return blob.includes(signature.toLowerCase()) || blob.includes(selector);
}

describe("TransferEOALegacyRouter — EIP-1167 clone path", function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, user3] = await ethers.getSigners();

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
      router,
      weth,
    ]);
    await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);

    const eoaLegacyCreationCode = (await ethers.getContractFactory("TransferEOALegacy")).bytecode;
    await transferEOALegacyRouter
      .connect(dev)
      .setLegacyCreationCode(eoaLegacyCreationCode, { gasLimit: 20_000_000 });

    const transferLegacyRouter = await deployProxy("TransferLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);
    const multisignLegacyRouter = await deployProxy("MultisigLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
    ]);

    await premiumSetting
      .connect(dev)
      .setParams(
        premiumRegistry.address,
        transferEOALegacyRouter.address,
        transferLegacyRouter.address,
        multisignLegacyRouter.address
      );
    await legacyDeployer.setParams(
      multisignLegacyRouter.address,
      transferLegacyRouter.address,
      transferEOALegacyRouter.address
    );
    await verifierTerm
      .connect(dev)
      .setRouterAddresses(transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);

    await premiumRegistry.connect(dev).createPlans([ethers.constants.MaxUint256], [1], [""], [""], [""]);
    const planId = await premiumRegistry.getNextPlanId();
    await premiumRegistry.connect(dev).subrcribeByAdmin(user1.address, Number(planId) - 1, "USDC");
    await premiumRegistry.connect(dev).subrcribeByAdmin(user2.address, Number(planId) - 1, "USDC");

    const TransferEOALegacy = await ethers.getContractFactory("TransferEOALegacy");
    const legacyImpl = await TransferEOALegacy.deploy();
    await transferEOALegacyRouter.connect(dev).setLegacyImplementation(legacyImpl.address);

    return {
      treasury,
      user1,
      user2,
      user3,
      dev,
      transferEOALegacyRouter,
      verifierTerm,
      premiumRegistry,
      premiumSetting,
      legacyDeployer,
      legacyImpl,
    };
  }

  function buildArgs() {
    return {
      mainConfig: {
        name: "clone-legacy",
        note: "",
        nickNames: ["alice"],
        distributions: [{ user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae", percent: 1000000 }],
      },
      extraConfig: { lackOfOutgoingTxRange: 86400, delayLayer2: 86400, delayLayer3: 86400 },
      layer2Distribution: { user: "0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b", percent: 1000000 },
      layer3Distribution: { user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD", percent: 1000000 },
      nickName2: "bob",
      nickName3: "carol",
    };
  }

  async function createLegacy(router_: any, signer: any, overrideName?: string) {
    const args = buildArgs();
    if (overrideName) args.mainConfig.name = overrideName;
    const predicted: string = await router_.getNextLegacyAddress(signer.address);
    const ts = await currentTime();
    const sig = await signer.signMessage(await genMessage(ts));
    const tx = await router_
      .connect(signer)
      .createLegacy(
        args.mainConfig,
        args.extraConfig,
        args.layer2Distribution,
        args.layer3Distribution,
        args.nickName2,
        args.nickName3,
        ts,
        sig
      );
    const receipt = await tx.wait();
    return { predicted, receipt, args };
  }

  it("setLegacyImplementation is gated by the code admin", async function () {
    const { transferEOALegacyRouter, user1, legacyImpl } = await loadFixture(deployFixture);
    let caught: any;
    try {
      await transferEOALegacyRouter.connect(user1).setLegacyImplementation(legacyImpl.address);
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected NotCodeAdmin revert");
    assert(revertedWith(caught, "NotCodeAdmin()"), `expected NotCodeAdmin, got: ${caught?.message}`);
  });

  it("getNextLegacyAddress uses clone prediction when impl is set", async function () {
    const { transferEOALegacyRouter, legacyDeployer, legacyImpl, user1 } = await loadFixture(deployFixture);
    const fromRouter: string = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    const fromDeployer: string = await legacyDeployer.getNextCloneAddress(legacyImpl.address, user1.address);
    assert.equal(fromRouter.toLowerCase(), fromDeployer.toLowerCase());
  });

  it("createLegacy deploys a 45-byte EIP-1167 proxy pointing at the impl", async function () {
    const { transferEOALegacyRouter, user1, legacyImpl } = await loadFixture(deployFixture);
    const { predicted, receipt } = await createLegacy(transferEOALegacyRouter, user1);

    const deployedCode: string = await ethers.provider.getCode(predicted);
    assert.equal(deployedCode.length, 92, `expected 45-byte proxy, got ${(deployedCode.length - 2) / 2} bytes`);
    const code = deployedCode.slice(2).toLowerCase();
    assert(code.startsWith(EIP1167_PREFIX), "missing EIP-1167 prefix");
    assert(code.endsWith(EIP1167_SUFFIX), "missing EIP-1167 suffix");

    const embeddedImpl = "0x" + code.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40);
    assert.equal(embeddedImpl.toLowerCase(), legacyImpl.address.toLowerCase());

    const gas = Number(receipt.gasUsed.toString());
    console.log(`    clone-path createLegacy gas used: ${gas.toLocaleString()}`);
    // Full bytecode path uses ~6.0M gas. Clones should be well under 1.5M.
    assert(gas < 1_500_000, `clone gas too high: ${gas}`);
  });

  it("cloned legacy exposes the full lifecycle just like a full deploy", async function () {
    const { transferEOALegacyRouter, user1 } = await loadFixture(deployFixture);
    const { predicted, args } = await createLegacy(transferEOALegacyRouter, user1);

    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);
    assert.equal(await legacy.isLive(), true);
    assert.equal((await legacy.getLayer()).toString(), "1");
    assert.equal(await legacy.getLegacyName(), args.mainConfig.name);
    assert.equal((await legacy.creator()).toLowerCase(), user1.address.toLowerCase());

    const [benes, l2, l3] = await legacy.getLegacyBeneficiaries();
    assert.equal(benes.length, 1);
    assert.equal(l2.toLowerCase(), args.layer2Distribution.user.toLowerCase());
    assert.equal(l3.toLowerCase(), args.layer3Distribution.user.toLowerCase());

    await increase(86400 * 2 + 1);
    assert.equal((await legacy.getLayer()).toString(), "2");
    await increase(86400);
    assert.equal((await legacy.getLayer()).toString(), "3");
  });

  it("re-calling initialize() on a clone reverts with LegacyAlreadyInitialized", async function () {
    const { transferEOALegacyRouter, user1 } = await loadFixture(deployFixture);
    const { predicted, args } = await createLegacy(transferEOALegacyRouter, user1);
    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);

    let caught: any;
    try {
      await legacy.initialize(
        0,
        user1.address,
        args.mainConfig.distributions,
        args.extraConfig,
        args.layer2Distribution,
        args.layer3Distribution,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
        args.mainConfig.nickNames,
        args.nickName2,
        args.nickName3
      );
    } catch (e) {
      caught = e;
    }
    assert(caught, "expected LegacyAlreadyInitialized revert");
    assert(revertedWith(caught, "LegacyAlreadyInitialized()"), `got: ${caught?.message}`);
  });

  it("setLegacyImplementation(address(0)) falls back to the bytecode path", async function () {
    const { transferEOALegacyRouter, dev, legacyDeployer, user1 } = await loadFixture(deployFixture);
    await transferEOALegacyRouter.connect(dev).setLegacyImplementation(ethers.constants.AddressZero);

    const fromRouter: string = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    const bytecode = (await ethers.getContractFactory("TransferEOALegacy")).bytecode;
    const fromDeployer: string = await legacyDeployer.getNextAddress(bytecode, user1.address);
    assert.equal(fromRouter.toLowerCase(), fromDeployer.toLowerCase());
  });

  it("distinct users produce distinct clones with isolated storage", async function () {
    const { transferEOALegacyRouter, user1, user2 } = await loadFixture(deployFixture);
    const { predicted: a1 } = await createLegacy(transferEOALegacyRouter, user1, "legacy-A");
    const { predicted: a2 } = await createLegacy(transferEOALegacyRouter, user2, "legacy-B");

    assert.notEqual(a1.toLowerCase(), a2.toLowerCase());
    const l1 = await ethers.getContractAt("TransferEOALegacy", a1);
    const l2 = await ethers.getContractAt("TransferEOALegacy", a2);
    assert.equal((await l1.creator()).toLowerCase(), user1.address.toLowerCase());
    assert.equal((await l2.creator()).toLowerCase(), user2.address.toLowerCase());
    assert.equal(await l1.getLegacyName(), "legacy-A");
    assert.equal(await l2.getLegacyName(), "legacy-B");
  });

  it("deleteLegacy + withdraw behave correctly on a clone", async function () {
    const { transferEOALegacyRouter, user1 } = await loadFixture(deployFixture);
    const { predicted } = await createLegacy(transferEOALegacyRouter, user1);
    const legacy = await ethers.getContractAt("TransferEOALegacy", predicted);

    await user1.sendTransaction({ to: predicted, value: ethers.utils.parseEther("0.01") });
    assert.equal(
      (await ethers.provider.getBalance(predicted)).toString(),
      ethers.utils.parseEther("0.01").toString()
    );

    const info = await legacy.getLegacyInfo();
    const legacyId = Number(info[0].toString());
    await transferEOALegacyRouter.connect(user1).deleteLegacy(legacyId);
    assert.equal(await legacy.isLive(), false);
    assert.equal((await ethers.provider.getBalance(predicted)).toString(), "0");
  });
});
