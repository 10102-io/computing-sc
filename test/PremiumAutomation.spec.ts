import Web3 from "web3";
import { ethers, network } from "hardhat";
import { BigNumber, ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentBlock, currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { expect, use } from "chai";
import { parseEther, parseUnits } from "ethers/lib/utils";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
import { PremiumMailRouter } from "../typechain-types";

import { genMessage } from "../scripts/utils/genMsg";
import { deployProxy } from "./utils/proxy";

const web3 = new Web3(process.env.RPC || "http://localhost:8545");
const user_pk = process.env.DEPLOYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const user = web3.eth.accounts.privateKeyToAccount(user_pk).address;
const wallet = web3.eth.accounts.privateKeyToAccount(user_pk);

describe("Premium Automation ", async function () {
  this.timeout(250000);
  const ONE_YEAR_PRICE = 1000;
  const FIVE_YEARS_PRICE = 2500;
  const LIFETIME_PRICE = 5000;

  const ONE_YEAR = 86400 * 365;
  const FIVE_YEARS = 86400 * 365 * 5;
  const LIFETIME = ethers.constants.MaxUint256;

  const routerUniswap = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
  const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

  const mailRouter = "0x01e8FBE1Bc34D73d86A61EbC24A0e9509C0B8799"; // mail router
  const mailBeforeActivation = "0x5C49EC40F5a512e2c4181bE1064CaCD55a930f16";
  const mailReadyToActivate = "0xDf105CA77a010860bf08fE52E454A2D5755354c6";
  const mailActivated = "0x05C807580CC173D2960304e870f4326a10E9A22C";

  //CHAINLINK AUTOMATION VARIABLES
  const i_link = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
  const i_registrar = "0xb0E49c5D0d05cbc241d68c05BC5BA1d1B7B72976";
  const keeperRegistry = "0x86EFBD0b6736Bed994962f9797049422A3A8E8Ad";

  //CHAINLINK FUNCTION VARIABLES
  const router = "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0"; //fix for sepolia
  const subcriptionId = 5168;
  const donID = "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000"; // fix for sepolia
  const gasLimit = "300000";

  function emailMapping(addr: string, email: string, name: string) {
    return { addr, email, name };
  }
  async function deployFixture() {
    const [treasury, user1, user2, user3] = await ethers.getSigners(); // Get the first signer (default account)

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x974763b760d566154B1767534cF9537CEe2f886f"],
    });

    const dev = await ethers.getSigner("0x974763b760d566154B1767534cF9537CEe2f886f");

    // Fund dev account with ETH for deployments
    await network.provider.send("hardhat_setBalance", [
      "0x974763b760d566154B1767534cF9537CEe2f886f",
      "0x1000000000000000000", // 1 ETH
    ]);

    // Deploy mock LINK token (18 decimals like real LINK)
    const MockLink = await ethers.getContractFactory("ERC20Token");
    const link = await MockLink.deploy("LINK", "LINK", 18);
    await link.mint(dev.address, parseEther("1000"));

    const premiumAutomationManager = await deployProxy("PremiumAutomationManager", [], "initialize", dev);

    await link.connect(dev).transfer(premiumAutomationManager.address, parseEther("100"));

    //Premium
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    const setting = await deployProxy("PremiumSetting", [], "initialize", dev);

    // Deploy mock Chainlink price feeds (8 decimals, ~$1 for stablecoins, ~$2000 for ETH)
    const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
    const usdtUsdFeed = await MockAggregator.deploy(8, 100000000); // $1.00
    const usdcUsdFeed = await MockAggregator.deploy(8, 100000000); // $1.00
    const ethUsdFeed = await MockAggregator.deploy(8, 200000000000); // $2000.00

    const registry = await deployProxy(
      "PremiumRegistry",
      [
        usdt.address,
        usdc.address,
        usdtUsdFeed.address,
        usdcUsdFeed.address,
        ethUsdFeed.address,
        setting.address,
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
      setting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);

    // Set the EOA legacy creation code (required for createLegacy via Create2)
    await transferEOALegacyRouter.connect(dev).initializeV2(dev.address);
    const eoaLegacyCreationCode = (await ethers.getContractFactory("TransferEOALegacy")).bytecode;
    await transferEOALegacyRouter.connect(dev).setLegacyCreationCode(eoaLegacyCreationCode, { gasLimit: 20_000_000 });

    const transferLegacyRouter = await deployProxy("TransferLegacyRouter", [
      legacyDeployer.address,
      setting.address,
      verifierTerm.address,
      payment.address,
      router,
      weth,
    ]);

    const multisignLegacyRouter = await deployProxy("MultisigLegacyRouter", [legacyDeployer.address, setting.address, verifierTerm.address]);

    await legacyDeployer.setParams(multisignLegacyRouter.address, transferLegacyRouter.address, transferEOALegacyRouter.address);

    await verifierTerm
      .connect(dev)
      .setRouterAddresses(transferEOALegacyRouter.address, transferLegacyRouter.address, transferEOALegacyRouter.address);

    // Deploy mock mail contracts (no-op implementations)
    const MockMail = await ethers.getContractFactory("MockPremiumSendMail");
    const mockMailBeforeActivation = await MockMail.deploy();
    const mockMailActivated = await MockMail.deploy();
    const mockMailReadyToActivate = await MockMail.deploy();

    // Deploy PremiumMailRouter locally via proxy
    const premiumMailRouter = (await deployProxy("PremiumMailRouter", [], "initialize", dev)) as PremiumMailRouter;

    await premiumMailRouter
      .connect(dev)
      .setParams(mockMailBeforeActivation.address, mockMailActivated.address, mockMailReadyToActivate.address, setting.address, premiumAutomationManager.address);

    // Deploy mock Chainlink Automation contracts
    const MockRegistrar = await ethers.getContractFactory("MockAutomationRegistrar");
    const mockRegistrar = await MockRegistrar.deploy(link.address);
    const MockKeeper = await ethers.getContractFactory("MockKeeperRegistryMaster");
    const mockKeeper = await MockKeeper.deploy(treasury.address);

    await premiumAutomationManager
      .connect(dev)
      .setParams(link.address, mockRegistrar.address, mockKeeper.address, setting.address, "500000", premiumMailRouter.address, 150);

    //set up
    await setting
      .connect(dev)
      .setParams(registry.address, transferEOALegacyRouter.address, transferLegacyRouter.address, multisignLegacyRouter.address);
    await setting.connect(dev).setUpReminder(premiumAutomationManager.address, premiumMailRouter.address);

    //mint token for users
    await usdt.mint(user1.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(user1.address, 100000 * 10 ** 6); // 100K usdc

    await usdt.mint(dev.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(dev.address, 100000 * 10 ** 6); // 100K usdc

    //subcribe plan
    // admin set up plans
    await registry
      .connect(dev)
      .createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

    // user subcribe for plan
    await usdc.connect(dev).approve(registry.address, ethers.constants.MaxUint256);
    await registry.connect(dev).subcribeWithUSDC(0);

    // Grant treasury premium time directly (treasury is a real Hardhat signer that can produce signatures)
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [registry.address] });
    await network.provider.send("hardhat_setBalance", [registry.address, "0x1000000000000000000"]);
    const registrySigner = await ethers.getSigner(registry.address);
    await setting.connect(registrySigner).updatePremiumTime(treasury.address, ONE_YEAR);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [registry.address] });

    // Mint tokens for treasury so it can create legacies
    await usdt.mint(treasury.address, 100000 * 10 ** 6);
    await usdc.mint(treasury.address, 100000 * 10 ** 6);

    return {
      dev,
      treasury,
      premiumAutomationManager,
      link,
      transferEOALegacyRouter,
      setting,
      registry,
      usdc,
      user1,
      user2,
      user3,
      premiumMailRouter,
      transferLegacyRouter,
      mockKeeper,
    };
  }
  it("should deploy fixture successfully", async function () {
    const { dev, premiumAutomationManager, link } = await loadFixture(deployFixture);

    // await premiumAutomationManager.connect(dev).createCronjob(dev.address);
  });

  // it("should set cronjob job for legacy", async function () {
  //     const { dev,
  //         premiumAutomationManager,
  //         transferEOALegacyRouter,
  //         link, setting,
  //         registry, usdc, user1 } = await loadFixture(deployFixture);

  //     //subcribe plan
  //     // admin set up plans
  //     await registry.createPlans(
  //         [ONE_YEAR, FIVE_YEARS, LIFETIME],
  //         [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
  //         ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
  //         ["", "", ""],
  //         ["", "", ""]
  //     )

  //     // user subcribe for plan
  //     await usdc.connect(dev).approve(registry.address, ethers.constants.MaxUint256);
  //     const planPriceUSDC = await registry.getPlanPriceUSDC(0);
  //     console.log({ planPriceUSDC });
  //     await registry.connect(dev).subcribeWithUSDC(0);

  //     const mainConfig = {
  //         name: "abc",
  //         note: "nothing",
  //         nickNames: ["dadad"],
  //         distributions: [
  //             {
  //                 user: "0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae",
  //                 percent: 100
  //             }
  //         ]
  //     };

  //     const extraConfig = {
  //         lackOfOutgoingTxRange: 86400,
  //         delayLayer2: 86400,
  //         delayLayer3: 86400
  //     };

  //     const layer2Distribution = {
  //         user: "0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b",
  //         percent: 100
  //     };

  //     const layer3Distribution = {
  //         user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
  //         percent: 100
  //     };

  //     const nickName2 = "daddd";
  //     const nickName3 = "dat";
  //     await transferEOALegacyRouter.connect(dev).createLegacy(
  //         mainConfig,
  //         extraConfig,
  //         layer2Distribution,
  //         layer3Distribution,
  //         nickName2,
  //         nickName3
  //     );

  //     const legacyAddress = await transferEOALegacyRouter.legacyAddresses(1);

  //     //set reminder config
  //     const name = "Dat";
  //     const ownerEmail = "user1@example.com";
  //     const timePriorActivation = 60 * 60 * 5;
  //     const legacyData = [
  //         {
  //             cosigners: [],
  //             beneficiaries: [
  //                 emailMapping("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae", "bene1@example.com"),
  //             ],
  //             secondLine: emailMapping("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b", "second1@example.com"),
  //             thirdLine: emailMapping("0xa0e95ACC5ec544f040b89261887C0BBa113981AD", "third1@example.com"),
  //         },
  //     ];

  //     await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);

  //     //merger tx
  //     // await premiumAutomationManager.connect(dev).createCronjob(dev.address);
  //     // await premiumAutomationManager.connect(dev).addLegacy(dev.address, [legacyAddress]);

  //     await premiumAutomationManager.connect(dev).addLegacyCronjob(dev.address, [legacyAddress]);

  //     let cronjobAddress = await premiumAutomationManager.cronjob(dev.address);
  //     const cronjob = (await ethers.getContractAt("PremiumAutomation", cronjobAddress));

  //     console.log(await cronjob.legacyContracts(0));

  //     const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
  //     console.log(await legacy.getTriggerActivationTimestamp());
  //     console.log(await setting.getTimeAhead(dev.address));
  //     let checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);

  //     await increase(3600 * 19);
  //     // console.log(await currentTime());
  //     // console.log(await legacy.getLayer());

  //     //notify 1 - before layer 1 activation
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))

  //     //notify 4 - ready to active
  //     await increase(3600 * 5);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))

  //     //notify 2 - befor layer 2
  //     await increase(3600 * 19);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))

  //     //notify 5 - layer 2 ready to active
  //     await increase(3600 * 6);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))

  //     //notify 3 - before layer 3
  //     await increase(3600 * 18);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))

  //     //notify 6 - layer 3 ready to active
  //     await increase(3600 * 9);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x");
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  //     console.log('Perform up keep');
  //     await cronjob.performUpkeep(checkUpkeepData[1]);
  //     checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
  //     console.log(checkUpkeepData);
  //     if (checkUpkeepData[1] != '0x') console.log(await cronjob.decodePerformData(checkUpkeepData[1]))
  // })

  it("shoud send reminder transfer/ transfer EOA", async function () {
    const { dev, treasury, premiumAutomationManager, transferEOALegacyRouter, link, setting, registry, usdc, user1, premiumMailRouter, user3 } =
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
      percent: 100,
    };

    const layer3Distribution = {
      user: user3.address,
      percent: 100,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";
    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(treasury.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await treasury.signMessage(message);

    await transferEOALegacyRouter
      .connect(treasury)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    //set reminder config
    const name = "Dat";
    const ownerEmail = "dat.tran2@sotatek.com";
    const timePriorActivation = 60 * 60 * 5;
    const legacyData = [
      {
        cosigners: [],
        beneficiaries: [emailMapping("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae", "dat.tran2@sotatek.com", "dat")],
        secondLine: emailMapping("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b", "dat.tran2@sotatek.com", "dat"),
        thirdLine: emailMapping(user3.address, "dat.tran2@sotatek.com", "dat"),
      },
    ];

    await usdc.mint(treasury.address, 1000 * 10 ** 6);
    await usdc.connect(treasury).approve(legacyAddress, 1000 * 10 ** 6);
    await network.provider.send("hardhat_setBalance", [
      legacyAddress,
      "0x1000000000000000000", // 1 ETH
    ]);

    await setting.connect(treasury).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);
    //await premiumAutomationManager.connect(dev).addLegacyCronjob(dev.address, [legacyAddress]);

    let cronjobAddress = await premiumAutomationManager.cronjob(treasury.address);
    const cronjob = await ethers.getContractAt("PremiumAutomation", cronjobAddress);

    // console.log(await cronjob.legacyContracts(0));

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    console.log(await legacy.getTriggerActivationTimestamp());
    console.log(await setting.getTimeAhead(dev.address));
    let checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);

    await increase(3600 * 19);
    // console.log(await currentTime());
    // console.log(await legacy.getLayer());

    //notify 1 - before layer 1 activation
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    //notify 4 - ready to active
    await increase(3600 * 5);
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    // //notify 2 - befor layer 2
    await increase(3600 * 19);
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    //notify 5 - layer 2 ready to active
    await increase(3600 * 6);
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    //notify 3 - before layer 3
    await increase(3600 * 18);
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    //notify 6 - layer 3 ready to active
    await increase(3600 * 9);
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("MailID", await premiumMailRouter.mailId());

    await transferEOALegacyRouter.connect(user3).activeLegacy(1, [usdc.address], true);
    console.log("Activated");
    console.log("MailID", await premiumMailRouter.mailId());
  });

  it("should fund keepup if needed", async function () {
    const { dev, treasury, premiumAutomationManager, transferEOALegacyRouter, link, setting, registry, usdc, user1, mockKeeper } = await loadFixture(
      deployFixture
    );

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
      percent: 100,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 100,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";
    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(treasury.address);
    console.log(legacyAddress);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await treasury.signMessage(message);

    await transferEOALegacyRouter
      .connect(treasury)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    //set reminder config
    const name = "Dat";
    const ownerEmail = "user1@example.com";
    const timePriorActivation = 60 * 60 * 5;
    const legacyData = [
      {
        cosigners: [],
        beneficiaries: [emailMapping("0xf19a87252C1d98EF7867E137fCA8ee24Aa3f47Ae", "bene1@example.com", "dat")],
        secondLine: emailMapping("0x9Ce08071d0ffF472dD1B0e3542A4B61Ac57a072b", "second1@example.com", "dat"),
        thirdLine: emailMapping("0xa0e95ACC5ec544f040b89261887C0BBa113981AD", "third1@example.com", "dat"),
      },
    ];

    await setting.connect(treasury).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);
    //await premiumAutomationManager.connect(dev).addLegacyCronjob(dev.address, [legacyAddress]);

    let cronjobAddress = await premiumAutomationManager.cronjob(treasury.address);
    const cronjob = await ethers.getContractAt("PremiumAutomation", cronjobAddress);
    const keepUpId = await cronjob.keepupId();
    console.log("Keepup ID", keepUpId);
    let keepUpBalance = await mockKeeper.getBalance(keepUpId);
    console.log("Keepup Balance", keepUpBalance);

    // console.log(await cronjob.legacyContracts(0));

    const legacy = await ethers.getContractAt("TransferEOALegacy", legacyAddress);
    console.log(await legacy.getTriggerActivationTimestamp());
    console.log(await setting.getTimeAhead(treasury.address));
    let checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);

    await increase(3600 * 19);
    // console.log(await currentTime());
    // console.log(await legacy.getLayer());

    //notify 1 - before layer 1 activation
    checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    await cronjob.performUpkeep(checkUpkeepData[1]);
    checkUpkeepData = await cronjob.checkUpkeep("0x"); //false
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));

    keepUpBalance = await mockKeeper.getBalance(keepUpId);
    console.log("Keepup Balance", keepUpBalance);
  });

  it("should trigger owner reset reminder", async function () {
    const { dev, treasury, premiumAutomationManager, transferEOALegacyRouter, link, setting, registry, usdc, user1, user2, user3, premiumMailRouter } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dat", "dat2"],
      distributions: [
        {
          user: user1.address,
          percent: 500000,
        },
        {
          user: "0x6f5e0e8B41CD7Fa814cD4eBe31dCD16F2Ef58372",
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
      user: user2.address,
      percent: 100,
    };

    const layer3Distribution = {
      user: user3.address,
      percent: 100,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";
    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(treasury.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await treasury.signMessage(message);

    await transferEOALegacyRouter
      .connect(treasury)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    //set reminder config
    //     const name = "Dat";
    //     const ownerEmail = "dat.tran2@sotatek.com";
    //     const timePriorActivation = 60 * 60 * 5;
    //     const legacyData = [
    //         {
    //             cosigners: [],
    //             beneficiaries: [
    //                 emailMapping(user1.address, "dat.tran2@sotatek.com", "dat"),
    //             ],
    //             secondLine: emailMapping(user2.address, "dat.tran2@sotatek.com", "dat"),
    //             thirdLine: emailMapping(user3.address, "dat.tran2@sotatek.com", "dat"),
    //         },
    //     ];

    //    await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);

    //     await increase(86400*2);

    //     console.log(await transferEOALegacyRouter.checkActiveLegacy(1));

    //     console.log('MailID', await premiumMailRouter.mailId());

    //     await transferEOALegacyRouter.connect(dev).avtiveAlive(1);

    //     console.log('MailID', await premiumMailRouter.mailId());
  });

  it("should trigger activation reminder", async function () {
    const { dev, treasury, premiumAutomationManager, transferEOALegacyRouter, link, setting, registry, usdc, user1, user2, user3, premiumMailRouter } =
      await loadFixture(deployFixture);

    const mainConfig = {
      name: "abc",
      note: "nothing",
      nickNames: ["dadad", "dat2"],
      distributions: [
        {
          user: user1.address,
          percent: 500000,
        },
        {
          user: "0x6f5e0e8B41CD7Fa814cD4eBe31dCD16F2Ef58372",
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
      user: user2.address,
      percent: 100,
    };

    const layer3Distribution = {
      user: user3.address,
      percent: 100,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";
    const legacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(treasury.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await treasury.signMessage(message);

    await transferEOALegacyRouter
      .connect(treasury)
      .createLegacy(mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    //set reminder config
    const name = "Dat";
    const ownerEmail = "dat.tran2@sotatek.com";
    const timePriorActivation = 60 * 60 * 5;
    const legacyData = [
      {
        cosigners: [],
        beneficiaries: [
          emailMapping(user1.address, "dat.tran2@sotatek.com", "dat"),
          emailMapping("0x6f5e0e8B41CD7Fa814cD4eBe31dCD16F2Ef58372", "dat.tran2@sotatek.com", "dat"),
        ],
        secondLine: emailMapping(user2.address, "dat.tran2@sotatek.com", "dat"),
        thirdLine: emailMapping(user3.address, "dat.tran2@sotatek.com", "dat"),
      },
    ];

    await setting.connect(treasury).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);

    await increase(86400);

    console.log(await transferEOALegacyRouter.checkActiveLegacy(1));
    console.log("MailID", await premiumMailRouter.mailId());

    await transferEOALegacyRouter.connect(user1).activeLegacy(1, [usdc.address], true);
    console.log("MailID", await premiumMailRouter.mailId());
  });

  it("should not notify if guard is not set", async function () {
    const {
      dev,
      treasury,
      premiumAutomationManager,
      transferEOALegacyRouter,
      link,
      setting,
      registry,
      usdc,
      user1,
      user2,
      user3,
      premiumMailRouter,
      transferLegacyRouter,
    } = await loadFixture(deployFixture);

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
      percent: 100,
    };

    const layer3Distribution = {
      user: "0xa0e95ACC5ec544f040b89261887C0BBa113981AD",
      percent: 100,
    };

    const nickName2 = "daddd";
    const nickName3 = "dat";

    const MockSafeWallet = await ethers.getContractFactory("MockSafeWallet");
    const mockSafeWallet = await MockSafeWallet.deploy([treasury.address]);
    const legacyAddress = await transferLegacyRouter.getNextLegacyAddress(treasury.address);
    const currentTimestamp = await currentTime();
    const message = await genMessage(currentTimestamp);
    const signature = await treasury.signMessage(message);

    await transferLegacyRouter
      .connect(treasury)
      .createLegacy(mockSafeWallet.address, mainConfig, extraConfig, layer2Distribution, layer3Distribution, nickName2, nickName3, currentTimestamp, signature);

    await mockSafeWallet.enableModule(legacyAddress);

    console.log(legacyAddress);
    const legacy = await ethers.getContractAt("TransferLegacy", legacyAddress);

    const name = "Dat";
    const ownerEmail = "user1@example.com";
    const timePriorActivation = 60 * 60 * 5;
    const legacyData = [
      {
        cosigners: [],
        beneficiaries: [emailMapping(user2.address, "bene1@example.com", "dat")],
        secondLine: emailMapping(user3.address, "second1@example.com", "dat"),
        thirdLine: emailMapping("0xa0e95ACC5ec544f040b89261887C0BBa113981AD", "third1@example.com", "dat"),
      },
    ];

    await setting.connect(treasury).setReminderConfigs(name, ownerEmail, timePriorActivation, [legacyAddress], legacyData);

    let cronjobAddress = await premiumAutomationManager.cronjob(treasury.address);
    const cronjob = await ethers.getContractAt("PremiumAutomation", cronjobAddress);

    await increase(3600 * 19);
    // console.log(await currentTime());
    // console.log(await legacy.getLayer());

    //notify 1 - before layer 1 activation
    const checkUpkeepData = await cronjob.checkUpkeep("0x");
    console.log(checkUpkeepData);
    if (checkUpkeepData[1] != "0x") console.log(await cronjob.decodePerformData(checkUpkeepData[1]));
    console.log("Perform up keep");
    console.log("MailID", await premiumMailRouter.mailId());
  });
});
