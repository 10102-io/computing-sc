import Web3 from "web3";
import { ethers, network } from "hardhat";
import { BigNumber, ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { expect, use } from "chai";
import { formatEther, parseEther } from "ethers/lib/utils";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";
const web3 = new Web3(process.env.RPC || "http://localhost:8545");
const user_pk = process.env.DEPLOYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const user = web3.eth.accounts.privateKeyToAccount(user_pk).address;
const wallet = web3.eth.accounts.privateKeyToAccount(user_pk);

const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

//Ensure legacy contract is compatible and friendly with Premium
describe("Legacy contract", async function () {
  this.timeout(150000);

  async function deployFixture() {
    const [treasury, dev, user1, user2, user3] = await ethers.getSigners(); // local accounts
    //deploy mock tokens
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const GenericLegacy = await ethers.getContractFactory("GenericLegacy");
    const genericLegacy = await GenericLegacy.deploy();

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

    // deployer contract
    const legacyDeployer = await deployProxy("LegacyDeployer");

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);

    // Required for CREATE2 EOA legacy deployments (legacyCreationCode is set post-deploy).
    await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
    const eoaLegacyCreationCode = (await ethers.getContractFactory("TransferEOALegacy")).bytecode;
    await transferEOALegacyRouter.connect(dev).setLegacyCreationCode(eoaLegacyCreationCode, { gasLimit: 20_000_000 });

    const transferLegacyRouter = await deployProxy("TransferLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);

    const multisignLegacyRouter = await deployProxy("MultisigLegacyRouter", [legacyDeployer.address, premiumSetting.address, verifierTerm.address]);
    await premiumSetting
      .connect(dev)
      .setParams(premiumRegistry.address, transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);

    await legacyDeployer.setParams(multisignLegacyRouter.address, transferLegacyRouter.address, transferEOALegacyRouter.address);

    await verifierTerm.connect(dev).setRouterAddresses(transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);

    //create lifetime subscription
    await premiumRegistry.connect(dev).createPlans([ethers.constants.MaxUint256], [1], [""], [""], [""]);
    const planId = await premiumRegistry.getNextPlanId();

    await premiumRegistry.connect(dev).subrcribeByAdmin(user1.address, Number(planId) - 1, "USDC");
    await premiumRegistry.connect(dev).subrcribeByAdmin(dev.address, Number(planId) - 1, "USDC");

    const MockSafeWallet = await ethers.getContractFactory("MockSafeWallet");
    const mockSafeWallet = await MockSafeWallet.deploy([dev.address]);

    return {
      genericLegacy,
      treasury,
      user1,
      user2,
      user3,
      transferEOALegacyRouter,
      transferLegacyRouter,
      multisignLegacyRouter,
      dev,
      verifierTerm,
      premiumSetting,
      premiumRegistry,
      usdc,
      usdt,
      mockSafeWallet,
    };
  }
  it("should deploy fixture successfully", async function () {
    const { genericLegacy, treasury, user1, user2, user3 } = await loadFixture(deployFixture);
  });

  it("should create transfer EOA legacy", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, dev, verifierTerm, premiumRegistry, premiumSetting } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: "0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b",
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const msg = await genMessage(currentTimestamp);
    const signature = await user1.signMessage(msg);
    console.log(msg);
    console.log(await verifierTerm.generateMessage(currentTimestamp));

    await transferEOALegacyRouter
      .connect(user1)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    console.log(await legacy.isLive());
    console.log(await legacy.getTriggerActivationTimestamp());
    console.log(await legacy.getLegacyBeneficiaries());
    expect(await legacy.getLayer()).to.be.eql(1);
    await increase(86400 * 2 + 1);
    expect(await legacy.getLayer()).to.be.eql(2);
    await increase(86400);
    expect(await legacy.getLayer()).to.be.eql(3);

    // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number

    expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name);
    console.log(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae"));
    console.log("Last timestamp", await legacy.getLastTimestamp());

    //update bene  name via setLegacyConfig
    console.log("update bene name via setLegacyConfig");
    let newConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dat"],
      distributions: [
        {
          user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
          percent: 1000000,
        },
      ],
    };

    const newlayer2Distribution = {
      user: "0xc3a20F9D15cfD2224038EcCC8186C216366c4BFd",
      percent: 1000000,
    };

    const newlayer3Distribution = {
      user: "0x85230A4Fc826149cd7CBF3Ad404420A28596D6CC",
      percent: 1000000,
    };

    const newNickname2 = "newNickname2";
    const newNickname3 = "newNickname3";
    await transferEOALegacyRouter
      .connect(user1)
      .setLegacyConfig(1, newConfig, extraConfig, newlayer2Distribution, newlayer3Distribution, newNickname2, newNickname3);

    //bene
    expect(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae")).to.be.eql(newConfig.nickNames[0]);
    expect(await legacy.getBeneNickname("0xc3a20F9D15cfD2224038EcCC8186C216366c4BFd")).to.be.eql(newNickname2);
    expect(await legacy.getBeneNickname("0x85230A4Fc826149cd7CBF3Ad404420A28596D6CC")).to.be.eql(newNickname3);
    expect(await legacy.getBeneNickname("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b")).to.be.eql("");
    expect(await legacy.getBeneNickname("0xa0e95ACC5ec544f040b89261887C0BBa113981AD")).to.be.eql("");

    //update bene name via setLegacy Distribution
    console.log("update bene name via setLegacy Distribution ");
    let nickNames = ["dat3", "dat4"];
    let newDistributions = [
      {
        user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
        percent: 500000,
      },
      {
        user: "0x9189CD497326A4D94236a028094247A561D895c9",
        percent: 500000,
      },
    ];
    await transferEOALegacyRouter.connect(user1).setLegacyDistributions(1, nickNames, newDistributions);
    expect(await legacy.getBeneNickname("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae")).to.be.eql(nickNames[0]);
    expect(await legacy.getBeneNickname("0x9189CD497326A4D94236a028094247A561D895c9")).to.be.eql(nickNames[1]);
  });

  it("should revert used sig ", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, dev, verifierTerm, premiumRegistry, premiumSetting } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: "0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b",
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const msg = await genMessage(currentTimestamp);
    const signature = await user1.signMessage(msg);

    await transferEOALegacyRouter
      .connect(user1)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    try {
      await transferEOALegacyRouter
        .connect(user2)
        .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);
    } catch (e) {
      expect(e?.toString()).to.contains("SignatureUsed()");
    }
  });

  it("should beneficiaries activate legacy and claim assets", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, dev, verifierTerm, premiumRegistry, usdc, usdt } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad", "dadad2"],
      distributions: [
        {
          user: user2.address,
          percent: 500000,
        },
        {
          user: user3.address,
          percent: 500000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: "0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b",
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const msg = await genMessage(currentTimestamp);
    const signature = await user1.signMessage(msg);

    await transferEOALegacyRouter
      .connect(user1)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);

    await usdc.mint(user1.address, 1000 * 10 ** 6);
    await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);
    await increase(86400 + 1);
    await network.provider.send("hardhat_setBalance", [
      legacyAddress,
      "0x1000000000000000000", // 1 ETH
    ]);
    const balanceLegacy = await ethers.provider.getBalance(legacyAddress);
    console.log("Contract balance:", formatEther(balanceLegacy), "ETH");

    //activate legacy successfully
    let balanceBene = await ethers.provider.getBalance(user2.address);
    console.log("Bene balance:", formatEther(balanceBene), "ETH");

    await transferEOALegacyRouter.connect(user2).activeLegacy(1, [usdc.address], false);

    expect(await usdc.balanceOf(user2.address)).to.equal(500 * 10 ** 6); // 50% of 1000 USDC

    balanceBene = await ethers.provider.getBalance(user2.address);
    console.log("Bene balance after claim:", formatEther(balanceBene), "ETH");
  });

  it("should layer2 activate legacy when time trigger passed", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, dev, verifierTerm, premiumRegistry, usdc, usdt, premiumSetting } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: user2.address,
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: user3.address,
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const msg = await genMessage(currentTimestamp);
    const signature = await user1.signMessage(msg);

    await transferEOALegacyRouter
      .connect(user1)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);
    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);

    await increase(86400 * 2);

    //now layer 2 can claim assets
    await usdc.mint(user1.address, 1000 * 10 ** 6);
    await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);
    await transferEOALegacyRouter.connect(user3).activeLegacy(1, [usdc.address], true);

    expect(await usdc.balanceOf(user3.address)).to.equal(1000 * 10 ** 6);
  });

  it("should create transfer legacy (Safe) ", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, premiumSetting, mockSafeWallet } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: user2.address,
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: user3.address,
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const safeWallet = mockSafeWallet.address;
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await dev.signMessage(message);

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    await mockSafeWallet.enableModule(legacyAddress);

    console.log(legacyAddress);
    const legacy = await ethers.getContractAt("TransferLegacy", legacyAddress);

    console.log(await legacy.isLive());
    console.log(await legacy.getTriggerActivationTimestamp());
    console.log(await legacy.getLegacyBeneficiaries());
    console.log(await legacy.getLayer()); //1

    await increase(86400 * 2 + 1);

    console.log(await legacy.getLayer()); //2

    await increase(86400);

    console.log(await legacy.getLayer()); // 3

    // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number
    expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name);

    console.log("Last timestamp", await legacy.getLastTimestamp());
  });

  it("should beneficiaries activate (Safe) legacy and claim assets", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, usdc, mockSafeWallet } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: user1.address,
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: user2.address,
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const safeWallet = mockSafeWallet.address;
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await dev.signMessage(message);

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    await mockSafeWallet.enableModule(legacyAddress);

    const legacy = await ethers.getContractAt("TransferLegacy", legacyAddress);

    await increase(86400);

    await usdc.mint(user1.address, 1000 * 10 ** 6);
    await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);

    //activate legacy successfully

    await transferLegacyRouter.connect(user1).activeLegacy(1, [usdc.address], true);

    expect(await usdc.balanceOf(user1.address)).to.equal(1000 * 10 ** 6);
  });

  it("should layer2 activate (Safe) legacy and claim assets", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, usdc, mockSafeWallet } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad"],
      distributions: [
        {
          user: user1.address,
          percent: 1000000,
        },
      ],
    };

    const extraConfig = {
      lackOfOutgoingTxRange: 86400,
      delayLayer2: 86400,
      delayLayer3: 86400,
    };

    const layer2Distribution = {
      user: user2.address,
      percent: 1000000,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 1000000,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const safeWallet = mockSafeWallet.address;
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await dev.signMessage(message);

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    await mockSafeWallet.enableModule(legacyAddress);

    const legacy = await ethers.getContractAt("TransferLegacy", legacyAddress);

    await increase(86400 * 2);
    await transferLegacyRouter.connect(user2).activeLegacy(1, [], true);
  });

  it("should create multisign legacy", async function () {
    const {
      genericLegacy,
      treasury,
      user1,
      user2,
      user3,
      transferEOALegacyRouter,
      transferLegacyRouter,
      multisignLegacyRouter,
      dev,
      premiumSetting,
      mockSafeWallet,
    } = await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad", "dadad"],
      beneficiaries: [user1.address, user2.address],
    };

    const extraConfig = {
      minRequiredSignatures: 1,
      lackOfOutgoingTxRange: 1,
    };

    const safeWallet = mockSafeWallet.address;
    const legacyAddress = await multisignLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await dev.signMessage(message);

    await multisignLegacyRouter.connect(dev).createLegacy(safeWallet, mainConfig, extraConfig, currentTimestamp, signature);

    await mockSafeWallet.enableModule(legacyAddress);

    const legacy = await ethers.getContractAt("MultisigLegacy", legacyAddress);

    console.log(await legacy.isLive());
    console.log(await legacy.getTriggerActivationTimestamp());
    console.log(await legacy.getLegacyBeneficiaries());

    // expect(await premiumSetting.connect(dev).getLegacyCode(legacyAddress)).to.be.gte(1000000); // a 7 digit number
    expect(await legacy.getLegacyName()).to.be.eql(mainConfig.name);
    console.log("Last timestamp", await legacy.getLastTimestamp());

    console.log(await premiumSetting.getBatchLegacyTriggerTimestamp([legacyAddress, legacyAddress]));
  });
});

describe("EOA Legacy autoSwap and unswap", async function () {
  this.timeout(150000);

  async function deploySwapFixture() {
    const [treasury, user1, user2] = await ethers.getSigners();

    // Deploy mock ERC20 storage token (6 decimals like USDC)
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const wethAddress = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9"; // placeholder for mock router

    // Deploy mock Uniswap router
    const MockRouter = await ethers.getContractFactory("MockUniswapV2Router");
    const mockRouter = await MockRouter.deploy(wethAddress);

    // Set rate: 1 ETH = 2000 USDC (at 1e18 ETH → 2000 * 1e6 USDC units)
    const USDC_RATE = ethers.utils.parseUnits("2000", 6); // 2000e6
    await mockRouter.setMockRate(usdc.address, USDC_RATE);
    // Set inverse rate: 2000e6 USDC → 1 ETH
    // ethOut = (amountIn * multiplier) / 1e18, so for 2000e6 → 1e18: multiplier = 1e36/2e9 = 5e26
    await mockRouter.setTokenToEthMultiplier(BigNumber.from("500000000000000000000000000")); // 5e26
    // Fund mock router with USDC (for autoSwap → transfer to owner)
    await usdc.mint(mockRouter.address, ethers.utils.parseUnits("1000000", 6));
    // Fund mock router with ETH (for unswap → send ETH back to owner)
    // Need enough for unswap: 2000 USDC (2000e6 units) * 1e12 = 2000e18 = 2000 ETH
    await network.provider.send("hardhat_setBalance", [
      mockRouter.address,
      "0x21E19E0C9BAB2400000", // 10000 ETH in hex
    ]);

    // Deploy infrastructure using treasury as admin (no impersonation needed)
    const premiumSetting = await deployProxy("PremiumSetting", [], "initialize", treasury);

    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    const ERC20Mock = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20Mock.deploy("USDT", "USDT", 6);

    const premiumRegistry = await deployProxy(
      "PremiumRegistry",
      [
        usdt.address,
        usdc.address,
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E", // chainlink price feed placeholder (non-zero)
        "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
        "0x694AA1769357215DE4FAC081bf1f309aDC325306",
        premiumSetting.address,
        payment.address,
      ],
      "initialize",
      treasury
    );

    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [treasury.address]);
    const legacyDeployer = await deployProxy("LegacyDeployer");

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      mockRouter.address,  // use mock router
      wethAddress,
    ]);

    const transferLegacyRouter = await deployProxy("TransferLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
      payment.address,
      mockRouter.address,
      wethAddress,
    ]);

    const multisignLegacyRouter = await deployProxy("MultisigLegacyRouter", [
      legacyDeployer.address,
      premiumSetting.address,
      verifierTerm.address,
    ]);

    await premiumSetting
      .connect(treasury)
      .setParams(premiumRegistry.address, transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);
    await legacyDeployer.setParams(multisignLegacyRouter.address, transferLegacyRouter.address, transferEOALegacyRouter.address);
    await verifierTerm.connect(treasury).setRouterAddresses(transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);

    // Set the EOA legacy creation code on the router (required for createLegacy via Create2).
    // gasLimit is explicit because ethers auto-estimation fails for large calldata in the test env.
    await transferEOALegacyRouter.connect(treasury).initializeV2(treasury.address);
    const eoaLegacyCreationCode = (await ethers.getContractFactory("TransferEOALegacy")).bytecode;
    await transferEOALegacyRouter.connect(treasury).setLegacyCreationCode(eoaLegacyCreationCode, { gasLimit: 20_000_000 });

    // Create lifetime plan and subscribe user1
    await premiumRegistry.connect(treasury).createPlans([ethers.constants.MaxUint256], [1], [""], [""], [""]);
    const planId = await premiumRegistry.getNextPlanId();
    await premiumRegistry.connect(treasury).subrcribeByAdmin(user1.address, Number(planId) - 1, "USDC");

    // Create an EOA legacy for user1
    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(user1.address);
    const currentTimestamp = await currentTime();
    const msg = await genMessage(currentTimestamp);
    const signature = await user1.signMessage(msg);

    const mainConfig = {
      name: "Test Legacy",
      note: "",
      nickNames: ["Bene"],
      distributions: [{ user: user2.address, percent: 1000000 }],
    };
    const extraConfig = { lackOfOutgoingTxRange: 86400, delayLayer2: 0, delayLayer3: 0 };
    const emptyDist = { user: ethers.constants.AddressZero, percent: 0 };

    await transferEOALegacyRouter
      .connect(user1)
      .createLegacy(mainConfig, extraConfig, emptyDist, emptyDist, "", "", currentTimestamp, signature);

    const legacyId = 1;

    return {
      treasury, user1, user2,
      usdc, mockRouter,
      transferEOALegacyRouter, legacyId, legacyAddress,
    };
  }

  it("autoSwap: swaps ETH to storage token and stores eoaStorageToken", async function () {
    const { user1, usdc, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    const ethAmount = ethers.utils.parseEther("1");
    const usdcBefore = await usdc.balanceOf(user1.address);

    const deadline = Math.floor(Date.now() / 1000) + 600;
    await transferEOALegacyRouter.connect(user1).autoSwap(
      legacyId,
      { storageToken: usdc.address, amountOutMin: 0, deadline },
      { value: ethAmount }
    );

    const usdcAfter = await usdc.balanceOf(user1.address);
    expect(usdcAfter.gt(usdcBefore)).to.be.true;

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    const storedToken = await legacy.eoaStorageToken();
    expect(storedToken.toLowerCase() === usdc.address.toLowerCase()).to.be.true;
  });

  it("unswap: pulls storage token from owner, swaps to ETH, clears eoaStorageToken", async function () {
    const { user1, usdc, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    const ethAmount = ethers.utils.parseEther("1");
    const deadline = Math.floor(Date.now() / 1000) + 600;

    // First do an autoSwap
    await transferEOALegacyRouter.connect(user1).autoSwap(
      legacyId,
      { storageToken: usdc.address, amountOutMin: 0, deadline },
      { value: ethAmount }
    );

    const usdcBalance = await usdc.balanceOf(user1.address);
    expect(usdcBalance.gt(0)).to.be.true;

    // Approve storage token to legacy contract (required for safeTransferFrom)
    await usdc.connect(user1).approve(legacyAddress, usdcBalance);

    // Unswap
    await transferEOALegacyRouter.connect(user1).unswap(
      legacyId,
      usdcBalance,
      0,
      deadline
    );

    const usdcAfter = await usdc.balanceOf(user1.address);
    expect(usdcAfter.toString() === "0").to.be.true;

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    const clearedToken = await legacy.eoaStorageToken();
    expect(clearedToken === "0x0000000000000000000000000000000000000000").to.be.true;
  });

  it("autoSwap: reverts when called by non-owner", async function () {
    const { user2, usdc, transferEOALegacyRouter, legacyId } =
      await loadFixture(deploySwapFixture);

    let didRevert = false;
    try {
      await transferEOALegacyRouter.connect(user2).autoSwap(
        legacyId,
        { storageToken: usdc.address, amountOutMin: 0, deadline: Math.floor(Date.now() / 1000) + 600 },
        { value: ethers.utils.parseEther("1") }
      );
    } catch (e: any) {
      didRevert = true;
    }
    expect(didRevert).to.be.true;
  });

  it("unswap: reverts when no active swap", async function () {
    const { user1, transferEOALegacyRouter, legacyId } =
      await loadFixture(deploySwapFixture);

    let didRevert = false;
    try {
      await transferEOALegacyRouter.connect(user1).unswap(
        legacyId,
        ethers.utils.parseEther("1"),
        0,
        Math.floor(Date.now() / 1000) + 600
      );
    } catch (e: any) {
      didRevert = true;
    }
    expect(didRevert).to.be.true;
  });

  // ── activeLegacyAndUnswap tests ──────────────────────────────────────────

  it("activeLegacyAndUnswap: atomically swaps storage token to ETH and distributes to beneficiary", async function () {
    const { user1, user2, usdc, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    const deadline = Math.floor(Date.now() / 1000) + 600;

    // 1. Owner does autoSwap: 1 ETH → USDC in user1's wallet
    await transferEOALegacyRouter.connect(user1).autoSwap(
      legacyId,
      { storageToken: usdc.address, amountOutMin: 0, deadline },
      { value: ethers.utils.parseEther("1") }
    );

    const usdcBalance = await usdc.balanceOf(user1.address);
    expect(usdcBalance.gt(0)).to.be.true;

    // 2. Owner approves legacy contract to spend USDC (required for claim-time swap)
    await usdc.connect(user1).approve(legacyAddress, usdcBalance);

    // 3. Fast-forward past the activation trigger (2 days > 1 day trigger)
    await increase(86400 * 2);

    const ethBefore = await ethers.provider.getBalance(user2.address);

    // 4. Beneficiary claims with atomic unswap — no ERC-20 assets (ETH-only distribution)
    await transferEOALegacyRouter.connect(user2).activeLegacyAndUnswap(
      legacyId,
      [],
      0,
      deadline
    );

    const ethAfter = await ethers.provider.getBalance(user2.address);
    // user2 received ETH (net of gas their balance should be higher)
    expect(BigNumber.from(ethAfter).gt(BigNumber.from(ethBefore))).to.be.true;

    // eoaStorageToken should be cleared
    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    expect((await legacy.eoaStorageToken()) === "0x0000000000000000000000000000000000000000").to.be.true;

    // USDC should be gone from user1's wallet
    expect((await usdc.balanceOf(user1.address)).toString() === "0").to.be.true;
  });

  it("activeLegacyAndUnswap: works with no active storage token (degrades to normal ETH distribution)", async function () {
    const { user1, user2, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    // Deposit ETH directly into the legacy contract
    await user1.sendTransaction({ to: legacyAddress, value: ethers.utils.parseEther("1") });

    await increase(86400 * 2);

    const ethBefore = await ethers.provider.getBalance(user2.address);
    const deadline = Math.floor(Date.now() / 1000) + 600;

    await transferEOALegacyRouter.connect(user2).activeLegacyAndUnswap(
      legacyId,
      [],
      0,
      deadline
    );

    const ethAfter = await ethers.provider.getBalance(user2.address);
    expect(BigNumber.from(ethAfter).gt(BigNumber.from(ethBefore))).to.be.true;

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    expect((await legacy.eoaStorageToken()) === "0x0000000000000000000000000000000000000000").to.be.true;
  });

  it("activeLegacy: clears eoaStorageToken when storage token is included in assets (claim-as-token path)", async function () {
    const { user1, user2, usdc, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    const deadline = Math.floor(Date.now() / 1000) + 600;

    // autoSwap: 1 ETH → USDC in user1's wallet
    await transferEOALegacyRouter.connect(user1).autoSwap(
      legacyId,
      { storageToken: usdc.address, amountOutMin: 0, deadline },
      { value: ethers.utils.parseEther("1") }
    );

    const usdcBalance = await usdc.balanceOf(user1.address);
    expect(usdcBalance.gt(0)).to.be.true;

    // Approve legacy contract so it can pull and distribute the token
    await usdc.connect(user1).approve(legacyAddress, usdcBalance);

    await increase(86400 * 2);

    // Claim the storage token as-is by passing it in the assets array (isETH = false)
    await transferEOALegacyRouter.connect(user2).activeLegacy(
      legacyId,
      [usdc.address],
      false
    );

    const legacyContract = await ethers.getContractAt("TransferEOALegacy", legacyAddress);

    // eoaStorageToken flag should be cleared
    expect((await legacyContract.eoaStorageToken()) === "0x0000000000000000000000000000000000000000").to.be.true;

    // user2 should have received USDC (proportional to their 100% share minus fee)
    expect((await usdc.balanceOf(user2.address)).gt(0)).to.be.true;
  });

  it("activeLegacyAndUnswap: skips swap and still distributes existing ETH when owner has no allowance", async function () {
    const { user1, user2, usdc, transferEOALegacyRouter, legacyId, legacyAddress } =
      await loadFixture(deploySwapFixture);

    const deadline = Math.floor(Date.now() / 1000) + 600;

    // autoSwap but do NOT approve — pullAmount will be 0, swap is skipped
    await transferEOALegacyRouter.connect(user1).autoSwap(
      legacyId,
      { storageToken: usdc.address, amountOutMin: 0, deadline },
      { value: ethers.utils.parseEther("1") }
    );

    // Also deposit direct ETH so there's something to distribute
    await user1.sendTransaction({ to: legacyAddress, value: ethers.utils.parseEther("0.5") });

    await increase(86400 * 2);

    const ethBefore = await ethers.provider.getBalance(user2.address);

    // Should succeed — swap skipped, existing ETH is distributed
    await transferEOALegacyRouter.connect(user2).activeLegacyAndUnswap(
      legacyId,
      [],
      0,
      deadline
    );

    const ethAfter = await ethers.provider.getBalance(user2.address);
    expect(BigNumber.from(ethAfter).gt(BigNumber.from(ethBefore))).to.be.true;

    // eoaStorageToken is still cleared (unconditionally inside the if block)
    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    expect((await legacy.eoaStorageToken()) === "0x0000000000000000000000000000000000000000").to.be.true;
  });
});
