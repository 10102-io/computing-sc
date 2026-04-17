import { ethers, network } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";

import { deployProxy } from "./utils/proxy";
import { currentTime } from "./utils/time";
import { genMessage } from "../scripts/utils/genMsg";

describe("MultisigLegacyRouter activation trigger", function () {
  this.timeout(120000);

  async function deployFixture() {
    const [treasury, owner, user2] = await ethers.getSigners();

    // non-zero placeholders used in other tests/config
    const uniswapRouter = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
    const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

    // deploy mock tokens
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    // Fund and impersonate the expected dev/admin used in other tests (keeps permissions consistent).
    await network.provider.send("hardhat_setBalance", [
      "0x974763b760d566154B1767534cF9537CEe2f886f",
      "0x1000000000000000000",
    ]);
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x974763b760d566154B1767534cF9537CEe2f886f"],
    });
    const dev = await ethers.getImpersonatedSigner("0x974763b760d566154B1767534cF9537CEe2f886f");

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
      uniswapRouter,
      weth,
    ]);

    const transferLegacyRouter = await deployProxy("TransferLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      uniswapRouter,
      weth,
    ]);

    // Create the multisig router (this is what we are testing)
    const multisigLegacyRouter = await deployProxy("MultisigLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
    ]);

    // Wire addresses (PremiumSetting + Deployer + Verifier)
    await premiumSetting
      .connect(dev)
      .setParams(premiumRegistry.address, transferEOALegacyRouter.address, transferLegacyRouter.address, multisigLegacyRouter.address);
    await legacyDeployer.setParams(multisigLegacyRouter.address, transferLegacyRouter.address, transferEOALegacyRouter.address);
    await verifierTerm.connect(dev).setRouterAddresses(transferEOALegacyRouter.address, transferLegacyRouter.address, multisigLegacyRouter.address);

    // Create plan and subscribe the legacy owner so setPrivateCodeAndCronjob doesn't revert
    await premiumRegistry.connect(dev).createPlans([ethers.constants.MaxUint256], [1], [""], [""], [""]);
    const planId = await premiumRegistry.getNextPlanId();
    await premiumRegistry.connect(dev).subrcribeByAdmin(owner.address, Number(planId) - 1, "USDC");

    // Safe mock that can return the guard slot and call router methods as the Safe
    const MockSafeWalletWithGuard = await ethers.getContractFactory("MockSafeWalletWithGuard");
    const mockSafeWallet = await MockSafeWalletWithGuard.deploy([owner.address]);

    return { owner, user2, dev, multisigLegacyRouter, mockSafeWallet };
  }

  it("updates activation trigger via router (regression for uint128/uint256 selector mismatch)", async function () {
    const { owner, user2, dev, multisigLegacyRouter, mockSafeWallet } = await loadFixture(deployFixture);

    const mainConfig = {
      name: "my multisig legacy",
      note: "n/a",
      nickNames: ["u2"],
      beneficiaries: [user2.address],
    };
    const extraConfig = {
      minRequiredSignatures: 1,
      lackOfOutgoingTxRange: 1,
    };

    const legacyAddress = await multisigLegacyRouter.getNextLegacyAddress(owner.address);

    const ts = await currentTime();
    const msg = await genMessage(ts);
    const signature = await owner.signMessage(msg);

    await multisigLegacyRouter.connect(owner).createLegacy(mockSafeWallet.address, mainConfig, extraConfig, ts, signature);

    const guardAddress = await multisigLegacyRouter.guardAddresses(1);

    // Make the mock safe look valid for onlySafeWallet checks
    await mockSafeWallet.setGuard(guardAddress);
    await mockSafeWallet.enableModule(legacyAddress);

    const legacy = await ethers.getContractAt("MultisigLegacy", legacyAddress);
    expect(await legacy.getActivationTrigger()).to.equal(1);

    // Call router.setActivationTrigger as if from the Safe wallet
    await mockSafeWallet.callRouterSetActivationTrigger(multisigLegacyRouter.address, 1, 123);

    expect(await legacy.getActivationTrigger()).to.equal(123);
  });
});

