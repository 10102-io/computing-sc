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
    const [treasury, user1, user2, user3] = await ethers.getSigners(); // Get the first signer (default account)
    //deploy mock tokens
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const GenericLegacy = await ethers.getContractFactory("GenericLegacy");
    const genericLegacy = await GenericLegacy.deploy();

    // Fund the account with ETH before impersonating
    await network.provider.send("hardhat_setBalance", [
      "0x974763b760d566154B1767534cF9537CEe2f886f",
      "0x1000000000000000000", // 1 ETH
    ]);

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x974763b760d566154B1767534cF9537CEe2f886f"],
    });

    const dev = await ethers.getSigner("0x974763b760d566154B1767534cF9537CEe2f886f");

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
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, premiumSetting } = await loadFixture(
      deployFixture
    );

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

    const safeWallet = "0x2eC4C5abe5789d85b3f9E8FE4107F3ceD29B0740";
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = wallet.sign(message).signature;

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

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
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, usdc } = await loadFixture(
      deployFixture
    );

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

    const safeWallet = "0x2eC4C5abe5789d85b3f9E8FE4107F3ceD29B0740";
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = wallet.sign(message).signature;

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    const legacy = await ethers.getContractAt("TransferLegacy", legacyAddress);

    await increase(86400);

    await usdc.mint(user1.address, 1000 * 10 ** 6);
    await usdc.connect(user1).approve(legacyAddress, 1000 * 10 ** 6);

    //activate legacy successfully

    await transferLegacyRouter.connect(user1).activeLegacy(1, [usdc.address], true);

    expect(await usdc.balanceOf(user1.address)).to.equal(1000 * 10 ** 6);
  });

  it("should layer2 activate (Safe) legacy and claim assets", async function () {
    const { genericLegacy, treasury, user1, user2, user3, transferEOALegacyRouter, transferLegacyRouter, dev, usdc } = await loadFixture(
      deployFixture
    );

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

    const safeWallet = "0x2eC4C5abe5789d85b3f9E8FE4107F3ceD29B0740";
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = wallet.sign(message).signature;

    await transferLegacyRouter
      .connect(dev)
      .createLegacy(safeWallet, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

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

    const safeWallet = "0x2eC4C5abe5789d85b3f9E8FE4107F3ceD29B0740";
    const legacyAddress = await multisignLegacyRouter.getNextLegacyAddress(dev.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = wallet.sign(message).signature;

    await multisignLegacyRouter.connect(dev).createLegacy(safeWallet, mainConfig, extraConfig, currentTimestamp, signature);

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
