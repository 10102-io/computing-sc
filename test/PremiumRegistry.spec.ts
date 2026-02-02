import Web3 from "web3";
import { ethers, network } from "hardhat";
import { BigNumber, ethers as ethersI } from "ethers";
import { assert } from "console";

import { currentTime, increase, increaseTo } from "./utils/time";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

import { expect, use } from "chai";
import { formatEther, formatUnits, parseEther, parseUnits } from "ethers/lib/utils";
import { seconds } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time/duration";
import { deployProxy } from "./utils/proxy";
import { genMessage as genTransferEOAMessage } from "../scripts/utils/genMsg";
const web3 = new Web3(process.env.RPC || "http://localhost:8545");
const user_pk = process.env.DEPLOYER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const user = web3.eth.accounts.privateKeyToAccount(user_pk).address;
const wallet = web3.eth.accounts.privateKeyToAccount(user_pk);

async function genMessage(legacyAddress: string, timestamp: number): Promise<string> {
  const message = `I agree to legacy at address ${legacyAddress.toLowerCase()} at timestamp ${timestamp}`;
  return message;
}

describe("Premium Setting", async function () {
  this.timeout(150000);

  const ONE_YEAR_PRICE = 1000;
  const FIVE_YEARS_PRICE = 2500;
  const LIFETIME_PRICE = 5000;

  const ONE_YEAR = 86400 * 365;
  const FIVE_YEARS = 86400 * 365 * 5;
  const LIFETIME = ethers.constants.MaxUint256;

  function emailMapping(addr: string, email: string, name: string) {
    return { addr, email, name };
  }

  async function deployFixture() {
    const [treasury, user1, user2, user3] = await ethers.getSigners(); // Get the first signer (default account)
    //deploy mock tokens
    const ERC20 = await ethers.getContractFactory("ERC20Token");
    const usdt = await ERC20.deploy("USDT", "USDT", 6);
    const usdc = await ERC20.deploy("USDC", "USDC", 6);

    const setting = await deployProxy("PremiumSetting");

    const Payment = await ethers.getContractFactory("Payment");
    const payment = await Payment.deploy();

    // Deploy mock Chainlink price feeds (8 decimals, ~$1 for stablecoins, ~$2000 for ETH)
    const MockAggregator = await ethers.getContractFactory("MockV3Aggregator");
    const usdtUsdFeed = await MockAggregator.deploy(8, 100000000); // $1.00
    const usdcUsdFeed = await MockAggregator.deploy(8, 100000000); // $1.00
    const ethUsdFeed = await MockAggregator.deploy(8, 200000000000); // $2000.00

    const registry = await deployProxy("PremiumRegistry", [
      usdt.address,
      usdc.address,
      usdtUsdFeed.address,
      usdcUsdFeed.address,
      ethUsdFeed.address,
      setting.address,
      payment.address,
    ]);

    //mint token for users
    await usdt.mint(user1.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(user1.address, 100000 * 10 ** 6); // 100K usdc

    await usdt.mint(user2.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(user2.address, 100000 * 10 ** 6); // 100K usdc

    await usdt.mint(user3.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(user3.address, 100000 * 10 ** 6); // 100K usdc

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: ["0x974763b760d566154B1767534cF9537CEe2f886f"],
    });

    const dev = await ethers.getSigner("0x974763b760d566154B1767534cF9537CEe2f886f");

    // Fund dev account with ETH
    await network.provider.send("hardhat_setBalance", [
      "0x974763b760d566154B1767534cF9537CEe2f886f",
      "0x1000000000000000000", // 1 ETH
    ]);
    await usdt.mint(dev.address, 100000 * 10 ** 6); // 100K usdt
    await usdc.mint(dev.address, 100000 * 10 ** 6); // 100K usdc

    const verifierTerm = await deployProxy("EIP712LegacyVerifier", [dev.address]);

    // Deploy legacy infrastructure
    const legacyDeployer = await deployProxy("LegacyDeployer");

    const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";

    const transferEOALegacyRouter = await deployProxy("TransferEOALegacyRouter", [
      legacyDeployer.address,
      setting.address,
      verifierTerm.address,
      payment.address,
      "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008", // Uniswap router (Sepolia)
      weth,
    ]);

    const multisignLegacyRouter = await deployProxy("MultisigLegacyRouter", [legacyDeployer.address, setting.address, verifierTerm.address]);

    await legacyDeployer.setParams(multisignLegacyRouter.address, treasury.address, transferEOALegacyRouter.address);

    //set up
    await setting.setParams(registry.address, transferEOALegacyRouter.address, treasury.address, multisignLegacyRouter.address);
    await verifierTerm.connect(dev).setRouterAddresses(transferEOALegacyRouter.address, multisignLegacyRouter.address, transferEOALegacyRouter.address);

    // Set dev as premium directly (impersonate registry to avoid conflicting with test subscriptions)
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [registry.address] });
    await network.provider.send("hardhat_setBalance", [registry.address, "0x1000000000000000000"]);
    const registrySigner = await ethers.getSigner(registry.address);
    await setting.connect(registrySigner).updatePremiumTime(dev.address, ONE_YEAR);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [registry.address] });

    // Create a transfer EOA legacy so tests have a valid legacy address
    const transferEOALegacyAddress = await transferEOALegacyRouter.getNextLegacyAddress(dev.address);
    const eoaTimestamp = await currentTime();
    const eoaMsg = await genTransferEOAMessage(eoaTimestamp);
    const eoaSig = await wallet.sign(eoaMsg).signature;
    await transferEOALegacyRouter.connect(dev).createLegacy(
      { name: "TestEOA", note: "", nickNames: ["bene1"], distributions: [{ user: user1.address, percent: 1000000 }] },
      { lackOfOutgoingTxRange: 86400, delayLayer2: 86400, delayLayer3: 86400 },
      { user: user2.address, percent: 100 },
      { user: user3.address, percent: 100 },
      "nick2", "nick3", eoaTimestamp, eoaSig
    );

    // Create a multisig legacy so tests have a valid multisig legacy address
    const safeWallet = "0x2eC4C5abe5789d85b3f9E8FE4107F3ceD29B0740";
    const multisigLegacyAddress = await multisignLegacyRouter.getNextLegacyAddress(dev.address);
    const msTimestamp = await currentTime();
    const msMsg = await genTransferEOAMessage(msTimestamp);
    const msSig = wallet.sign(msMsg).signature;
    await multisignLegacyRouter.connect(dev).createLegacy(
      safeWallet,
      { name: "TestMultisig", note: "", nickNames: ["bene1", "bene2"], beneficiaries: [user1.address, user2.address] },
      { minRequiredSignatures: 1, lackOfOutgoingTxRange: 1 },
      msTimestamp, msSig
    );

    return {
      usdt,
      usdc,
      registry,
      setting,
      treasury,
      user1,
      user2,
      user3,
      dev,
      multisignLegacyRouter,
      transferEOALegacyRouter,
      payment,
      transferEOALegacyAddress,
      multisigLegacyAddress,
    };
  }

  describe("Deployemnt", async function () {
    it("should deploy fixture successfully", async function () {
      const { usdt, usdc, registry, treasury, setting } = await loadFixture(deployFixture);
      expect(await registry.owner()).to.be.eql(treasury.address);
    });
  });

  describe("[Admin] Manage plan", async function () {
    it("should setup plans successfully", async function () {
      const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );
      expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
      expect(await registry.getPlanPriceUSD(1)).to.be.eq(FIVE_YEARS_PRICE);
      expect(await registry.getPlanPriceUSD(2)).to.be.eq(LIFETIME_PRICE);
      expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);
      expect(await registry.getPlanDuration(1)).to.be.eq(FIVE_YEARS);
      expect(await registry.getPlanDuration(2)).to.be.eq(LIFETIME);
    });

    it("should update plan", async function () {
      const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );
      expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
      expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);

      await registry.updatePlans([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 2], ["TWO YEAR"], [""], [""]);

      expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE * 2);
      expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR * 2);
    });

    it("should update plan price and duration", async function () {
      const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );
      expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE);
      expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR);

      await registry.updatePlansPriceAndDuration([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 4]);

      expect(await registry.getPlanPriceUSD(0)).to.be.eq(ONE_YEAR_PRICE * 4);
      expect(await registry.getPlanDuration(0)).to.be.eq(ONE_YEAR * 2);
    });

    it("should remove plan", async function () {
      const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );
      await registry.removePlans([0]);

      try {
        await registry.getPlanPriceUSD(0);
      } catch (e) {
        expect(e?.toString()).to.contains("Plan has been removed");
      }

      try {
        await registry.getPlanDuration(0);
      } catch (e) {
        expect(e?.toString()).to.contains("Plan has been removed");
      }

      //update after remove should fail
      try {
        await registry.updatePlans([0], [ONE_YEAR * 2], [ONE_YEAR_PRICE * 2], ["TWO YEAR"], [""], [""]);
      } catch (e) {
        expect(e?.toString()).to.contains("Plan has been removed");
      }
    });
  });

  describe("should calculate plan prices with decimals 2", async function () {
    it("should setup plans successfully", async function () {
      const { usdt, usdc, registry, setting, treasury } = await loadFixture(deployFixture);
      await registry.createPlans([ONE_YEAR, FIVE_YEARS, LIFETIME], [10, 50, 100], ["ONE YEAR", "FIVE YEAR", "LIFETIME"], ["", "", ""], ["", "", ""]);
      console.log(formatUnits(await registry.getPlanPriceUSDC(0), 6));
      console.log(formatUnits(await registry.getPlanPriceUSDC(1), 6));
      console.log(formatUnits(await registry.getPlanPriceUSDC(2), 6));
      console.log(formatUnits(await registry.getPlanPriceUSDT(0), 6));
      console.log(formatUnits(await registry.getPlanPriceUSDT(1), 6));
      console.log(formatUnits(await registry.getPlanPriceUSDT(2), 6));
      console.log(formatEther(await registry.getPlanPriceETH(0)));
      console.log(formatEther(await registry.getPlanPriceETH(1)));
      console.log(formatEther(await registry.getPlanPriceETH(2)));
    });
  });

  describe("[User] Subcribe plans", async function () {
    it("should user subcribe with USDC", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

      // admin set up plans
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

      // user subcribe for plan
      await usdc.connect(user1).approve(registry.address, ethers.constants.MaxUint256);
      const planPriceUSDC = await registry.getPlanPriceUSDC(0);
      console.log({ planPriceUSDC });
      await registry.connect(user1).subcribeWithUSDC(0);
      expect(await usdc.balanceOf(user1.address)).to.be.eq(100000n * 10n ** 6n - BigInt(planPriceUSDC));
      expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);
      // await expect(setting.connect(user1).setEmails()).to.not.reverted;
      // try {
      //     await setting.connect(user2).setEmails(); //non-premium user
      // } catch (e) {
      //     expect(e?.toString()).to.contains("Premium only");
      // }
    });

    it("should user subcribe with ETH", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);
      // admin set up plans
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

      //user subcribe plans

      const planPriceETH = await registry.getPlanPriceETH(0);
      console.log({ planPriceETH });
      const ethBalBefore = await ethers.provider.getBalance(user1.address);
      await registry.connect(user1).subcribeWithETH(0, {
        value: planPriceETH,
      });
      const ethBalAfter = await ethers.provider.getBalance(user1.address);
      expect(BigNumber.from(ethBalBefore).sub(BigNumber.from(ethBalAfter))).to.be.gte(BigNumber.from(planPriceETH)); // gas consumed in tx
      expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);

      // await expect(setting.connect(user1).setEmails()).to.not.reverted;
      // try {
      //     await setting.connect(user2).setEmails(); //non-premium user
      // } catch (e) {
      //     expect(e?.toString()).to.contains("Premium only");
      // }
    });

    it("should user subcribe Lifetime", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);
      // admin set up plans
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

      //user subcribe plans
      await usdc.connect(user1).approve(registry.address, ethers.constants.MaxUint256);
      const planPriceUSDC = await registry.getPlanPriceETH(0);
      console.log({ planPriceUSDC });
      await registry.connect(user1).subcribeWithUSDC(2);
      expect(await setting.premiumExpired(user1.address)).to.be.gt(0n);

      // await expect(setting.connect(user1).setEmails()).to.not.reverted;
      // try {
      //     await setting.connect(user2).setEmails(); //non-premium user
      // } catch (e) {
      //     expect(e?.toString()).to.contains("Premium only");
      // }
    });

    it("should transfer purchase to payment", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, payment } = await loadFixture(deployFixture);
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

      //user 1 subcribe with usdc
      await usdc.connect(user1).approve(registry.address, ethers.constants.MaxUint256);
      const planPriceUSDC = await registry.getPlanPriceUSDC(0);
      console.log({ planPriceUSDC });
      await registry.connect(user1).subcribeWithUSDC(0);
      expect(await usdc.balanceOf(payment.address)).to.be.eq(planPriceUSDC);

      //user 2 subcribe with usdt
      await usdt.connect(user2).approve(registry.address, ethers.constants.MaxUint256);
      const planPriceUSDT = await registry.getPlanPriceUSDT(0);
      console.log({ planPriceUSDT });
      await registry.connect(user2).subcribeWithUSDT(0);
      expect(await usdt.balanceOf(payment.address)).to.be.eq(planPriceUSDT);

      //user 3 subcribe with eth
      const planPriceETH = await registry.getPlanPriceETH(0);
      console.log({ planPriceETH });
      await registry.connect(user3).subcribeWithETH(0, {
        value: planPriceETH,
      });
      const paymentEthBalance = await ethers.provider.getBalance(payment.address);
      expect(paymentEthBalance).to.be.eq(planPriceETH);
    });

    it("should reject subcribe removed plan", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

      // admin set up plans
      await registry.createPlans(
        [ONE_YEAR, FIVE_YEARS, LIFETIME],
        [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
        ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
        ["", "", ""],
        ["", "", ""]
      );

      //admin remove a plan
      await registry.removePlans([0]);

      //user subcribe removed plan
      try {
        await registry.connect(user1).subcribeWithETH(0, {
          value: parseEther("1000"),
        });
      } catch (e) {
        expect(e?.toString()).to.contains("Plan has been removed");
      }
    });
  });

  describe("[User] Set config email reminder", async function () {
    it("should user set cofig successfully", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, transferEOALegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [transferEOALegacyAddress];

      const legacyData = [
        {
          cosigners: [],
          beneficiaries: [emailMapping(user1.address, "bene1@example.com", "dat")],
          secondLine: emailMapping(user2.address, "second1@example.com", "dat"),
          thirdLine: emailMapping(user3.address, "third1@example.com", "dat"),
        },
      ];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

      console.log(await setting.userConfigs(dev.address));

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));
    });

    it("should user set cofig SAFE successfully", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisigLegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [multisigLegacyAddress];

      const legacyData = [
        {
          cosigners: [
            emailMapping("0x974763b760d566154B1767534cF9537CEe2f886f", "dat.tran2@sotatek.com", "dat"),
          ],
          beneficiaries: [],
          secondLine: emailMapping(ethers.constants.AddressZero, "", ""),
          thirdLine: emailMapping(ethers.constants.AddressZero, "", ""),
        },
      ];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

      console.log(await setting.userConfigs(dev.address));

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));
    });

    it("should user clear config", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, transferEOALegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [transferEOALegacyAddress];

      const legacyData = [
        {
          cosigners: [],
          beneficiaries: [emailMapping(user1.address, "bene1@example.com", "dat")],
          secondLine: emailMapping(user2.address, "second1@example.com", "dat"),
          thirdLine: emailMapping(user3.address, "third1@example.com", "dat"),
        },
      ];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

      console.log(await setting.userConfigs(user1.address));

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));

      await setting.connect(dev).clearLegacyConfig(legacyAddresses);

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));
    });

    it("should user set cofig successfully", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, transferEOALegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [transferEOALegacyAddress];

      const legacyData = [
        {
          cosigners: [],
          beneficiaries: [emailMapping(user1.address, "bene1@example.com", "dat")],
          secondLine: emailMapping(user2.address, "second1@example.com", "dat"),
          thirdLine: emailMapping(user3.address, "third1@example.com", "dat"),
        },
      ];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

      console.log(await setting.userConfigs(dev.address));

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));
    });

    it("should user set cofig multisign successfully", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisigLegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [multisigLegacyAddress];

      const legacyData = [
        {
          cosigners: [],
          beneficiaries: [emailMapping(user1.address, "bene1@example.com", "dat")],
          secondLine: emailMapping("0x0000000000000000000000000000000000000000", "", ""),
          thirdLine: emailMapping("0x0000000000000000000000000000000000000000", "", "dat"),
        },
      ];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);

      console.log(await setting.userConfigs(dev.address));

      console.log(await setting.getCosignerData(legacyAddresses[0]));
      console.log(await setting.getBeneficiaryData(legacyAddresses[0]));
      console.log(await setting.getSecondLineData(legacyAddresses[0]));
      console.log(await setting.getThirdLineData(legacyAddresses[0]));
    });
  });

  describe("[User] Set watchers", async function () {
    it("should user set watcher", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, transferEOALegacyAddress } = await loadFixture(deployFixture);
      const name = "Dat";
      const ownerEmail = "user1@example.com";
      const timePriorActivation = 3600;
      const emptyLegacyAddresses: any[] = [];
      const emptyLegacyData: any[] = [];
      const legacyAddresses = [transferEOALegacyAddress];

      // dev is already premium from fixture — set config
      await setting.connect(dev).setWatchers(legacyAddresses[0], ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
      await setting.connect(dev).clearWatcher(legacyAddresses);
    });

    it("should user set watcher for multisign legacy", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisigLegacyAddress } = await loadFixture(deployFixture);

      // Fixture already created plans, subscribed dev, and created a multisig legacy
      // set config
      await setting.connect(dev).setWatchers(multisigLegacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
    });
    it("should user set watcher for multisig legacy 2", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisigLegacyAddress } = await loadFixture(deployFixture);

      // dev is already premium from fixture
      await setting.connect(dev).setWatchers(multisigLegacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
    });

    it("should user clear watcher ", async function () {
      const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev, multisigLegacyAddress } = await loadFixture(deployFixture);

      // dev is already premium from fixture
      await setting.connect(dev).setWatchers(multisigLegacyAddress, ["Dat"], ["0xd1999d5a27378970420779b0722118f20858f198"], [true]);
      await setting.connect(dev).clearWatcher([multisigLegacyAddress]);
    });
  });

  // it("should router sync beneficiaries emails", async function () {
  //     const { usdt, usdc, registry, setting, treasury, user1, user2, user3, dev } = await loadFixture(deployFixture);
  //     const name = "Dat";
  //     const ownerEmail = "user1@example.com";
  //     const timePriorActivation = 3600;
  //      const legacyAddresses = ["0xd1999d5a27378970420779b0722118f20858f198"];

  //     const legacyData = [
  //         {
  //             cosigners: [],
  //             beneficiaries: [
  //                 emailMapping("0x8e4e77cee39f54b7445441ac35a6f6fa4f541b00", "bene1@example.com"),
  //             ],
  //             secondLine: emailMapping("0xc3a20f9d15cfd2224038eccc8186c216366c4bfd", "second1@example.com"),
  //             thirdLine: emailMapping("0x9189cd497326a4d94236a028094247a561d895c9", "third1@example.com"),
  //         },
  //     ];

  //     // admin set up plans
  //     await registry.createPlans(
  //         [ONE_YEAR, FIVE_YEARS, LIFETIME],
  //         [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
  //         ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
  //         ["", "", ""],
  //         ["", "", ""]
  //     )

  //     const newDistributions = [{ user: user3.address, percent: 100 }]

  //     // user subcribe for plan
  //     await usdc.connect(dev).approve(registry.address, ethers.constants.MaxUint256);
  //     await registry.connect(dev).subcribeWithUSDC(0);

  //     // set config
  //     await setting.connect(dev).setReminderConfigs(name, ownerEmail, timePriorActivation, legacyAddresses, legacyData);
  //     let beneficiaryEmails = await setting.getBeneficiaryData(user1.address)

  //     //router update bene emails
  //     console.log({ beneficiaryEmails });
  //     await setting.connect(treasury).syncBeneficiariesEmails(user1.address, user1.address, newDistributions)

  //     beneficiaryEmails = await setting.getBeneficiaryEmails(user1.address)
  //     console.log({ beneficiaryEmails });

  // })

  //     it("should router reset layers emails", async function () {
  //         const { usdt, usdc, registry, setting, treasury, user1, user2, user3 } = await loadFixture(deployFixture);

  //         const ownerEmail = "user1@example.com";
  //         const timePriorActivation = 3600;
  //         const legacyAddresses = [user1.address, user2.address];

  //         const legacyData = [
  //             {
  //                 cosigners: [emailMapping(user2.address, "cosigner1@example.com")],
  //                 beneficiaries: [
  //                     emailMapping(user3.address, "bene1@example.com"),
  //                     emailMapping(treasury.address, "bene2@example.com")
  //                 ],
  //                 secondLine: emailMapping(user2.address, "second1@example.com"),
  //                 thirdLine: emailMapping(user3.address, "third1@example.com"),
  //                 watchers: [emailMapping(treasury.address, "watcher1@example.com")]
  //             },
  //             {
  //                 cosigners: [],
  //                 beneficiaries: [emailMapping(user2.address, "bene3@example.com")],
  //                 secondLine: emailMapping(user3.address, "second2@example.com"),
  //                 thirdLine: emailMapping(treasury.address, "third2@example.com"),
  //                 watchers: []
  //             }
  //         ];

  //         // admin set up plans
  //         await registry.createPlans(
  //             [ONE_YEAR, FIVE_YEARS, LIFETIME],
  //             [ONE_YEAR_PRICE, FIVE_YEARS_PRICE, LIFETIME_PRICE],
  //             ["ONE YEAR", "FIVE YEAR", "LIFETIME"],
  //             ["", "", ""],
  //             ["", "", ""]

  //         )
  //         const newDistributions = [{ user: user3.address, percent: 100 }]

  //         // user subcribe for plan
  //         await usdc.connect(user1).approve(registry.address, ethers.constants.MaxUint256);
  //         await registry.connect(user1).subcribeWithUSDC(0);

  //         // set config
  //         await setting.connect(user1).setReminderConfigs(ownerEmail, timePriorActivation, legacyAddresses, legacyData);
  //         let secondLineEmail = await setting.getSecondLineEmail(user1.address);
  //         console.log({ secondLineEmail });

  //         //router reset layer emails
  //         await setting.connect(treasury).resetLayerEmail(user1.address, user1.address, 2);
  //         secondLineEmail = await setting.getSecondLineEmail(user1.address);
  //         console.log({ secondLineEmail });

  //         //router reset
  //         let thirdLineEmail = await setting.getSecondLineEmail(user1.address);
  //         console.log({ thirdLineEmail });
  //         await setting.connect(treasury).resetLayerEmail(user1.address, user1.address, 3);
  //         thirdLineEmail = await setting.getSecondLineEmail(user1.address);
  //         console.log({ thirdLineEmail });
  //     })
  // })
});

// WucU6sHlFfMHUN-MX7BFTPhVvkkrNwIV
