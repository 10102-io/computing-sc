import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { TransferLegacy, TransferLegacyRouter, LegacyToken } from "../typechain-types";
import { TransferLegacyStruct } from "../typechain-types/contracts/TransferLegacyRouter";

describe("TransferLegacyRouter", function () {
  async function deployRouterFixture() {
    const [deployer, operator, feeReceiver, user1, user2, user3] = await ethers.getSigners();
    // Deploy mock ERC20
    const erc20Contract1 = await ethers.deployContract("LegacyToken", ["Legacy V1", "WV1"], deployer);
    await erc20Contract1.waitForDeployment();
    const erc20Contract2 = await ethers.deployContract("LegacyToken", ["Legacy V2", "WV2"], deployer);
    await erc20Contract2.waitForDeployment();
    // Deploy ERC20Whitelist
    const erc20Whitelist = await ethers.deployContract("ERC20Whitelist", deployer);
    await erc20Whitelist.waitForDeployment();
    // Set whitelist
    await erc20Whitelist.connect(deployer).updateWhitelist([erc20Contract1.target, erc20Contract2.target], true);
    // Deploy TransferLegacyRouter
    const TransferLegacyRouter = await ethers.deployContract(
      "TransferLegacyRouter",
      [0, feeReceiver.address, 0, erc20Whitelist.target],
      deployer
    );
    await TransferLegacyRouter.waitForDeployment();
    await TransferLegacyRouter.connect(deployer).addOperator(operator.address);
    const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

    return {
      deployer,
      operator,
      feeReceiver,
      user1,
      user2,
      user3,
      erc20Contract1,
      erc20Contract2,
      erc20Whitelist,
      TransferLegacyRouter,
      ETH_ADDRESS,
    };
  }

  /* Deployment */
  describe("Deployment", function () {
    it("Should set the right admin", async function () {
      const { deployer, TransferLegacyRouter } = await loadFixture(deployRouterFixture);

      const ADMIN_ROLE = await TransferLegacyRouter.DEFAULT_ADMIN_ROLE();
      expect(await TransferLegacyRouter.hasRole(ADMIN_ROLE, deployer.address)).to.be.true;
    });

    it("Should set the right configures", async function () {
      const { feeReceiver, erc20Whitelist, TransferLegacyRouter } = await loadFixture(deployRouterFixture);

      expect(await TransferLegacyRouter.legacyFee()).to.equal(0);
      expect(await TransferLegacyRouter.feeReceiver()).to.equal(feeReceiver.address);
      expect(await TransferLegacyRouter.legacyLimit()).to.equal(0);
      expect(await TransferLegacyRouter.erc20Whitelist()).to.equal(erc20Whitelist.target);
    });
  });

  async function getLegacyContract(legacyAddress: string) {
    const TransferLegacyFactory = await ethers.getContractFactory("TransferLegacy");
    const TransferLegacy: TransferLegacy = TransferLegacyFactory.attach(legacyAddress) as any;
    return TransferLegacy;
  }

  const extraConfig: TransferLegacyStruct.LegacyExtraConfigStruct = {
    minRequiredSignatures: 1,
    lackOfOutgoingTxRange: 2,
  };

  async function createLegacy(
    user1: any,
    user2: any,
    user3: any,
    TransferLegacyRouter: TransferLegacyRouter,
    erc20Contract1: LegacyToken,
    erc20Contract2: LegacyToken,
    ETH_ADDRESS: string,
    value: bigint = BigInt(0)
  ) {
    const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
      name: "My legacy",
      note: "For my family",
      nickNames: ["Dad", "Mom"],
      distributions: [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 50, 100],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target],
          percents: [80, 50],
        },
      ],
    };
    const mainConfigTuple = [
      mainConfig.name,
      mainConfig.note,
      mainConfig.nickNames,
      [
        [user2.address, [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS], [20, 50, 100]],
        [user3.address, [erc20Contract1.target, erc20Contract2.target], [80, 50]],
      ],
    ];
    const extraConfigTuple = [extraConfig.minRequiredSignatures, extraConfig.lackOfOutgoingTxRange];

    const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
    await TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig, { value });
    const legacyId = await TransferWiLegacyuter.legacyId();

    return { legacyId, legacyAddress, mainConfig, extraConfig, mainConfigTuple, extraConfigTuple };
  }

  async function getTimestampOfNextBlock() {
    const nextTimestamp = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(nextTimestamp);
    return nextTimestamp;
  }

  /* Create legacy */
  describe("Create legacy", function () {
    // Happy cases
    it("Should change router state", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const newLegacyId = (await TransferLegacyRouter.legacyId()) + BigInt(1);
      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const legacyCountByUser = (await TransferWiLegacyuter.legacyCountByUsers(user1.address)) + BigInt(1);
      const nonceByUser = (await TransferLegacyRouter.nonceByUsers(user1.address)) + BigInt(1);

      await createLegacy(user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS);

      expect(await TransferLegacyRouter.legacyId()).to.equal(newWiLegacy);
      expect(await TransferLegacyRouter.legacyAddresses(newWiLegacy)).to.equal(legacyAddress);
      expect(await TransferLegacyRouter.legacyCountByUsers(user1.address)).to.equal(legacyCountByUser);
      expect(await TransferLegacyRouter.nonceByUsers(user1.address)).to.equal(nonceByUser);
    });

    it("Should change Transfer legacy state", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      expect(await TransferLegacy.getLegacyInfo()).to.deep.equal([legacyId, user1.address, 1]);
      expect(await TransferLegacy.getActivationTrigger()).to.equal(2);
      expect(await TransferLegacy.minRequiredSignatures()).to.equal(1);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(20);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(80);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(100);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(0);
      expect(await TransferLegacy.getBeneficiaries()).to.deep.equal([user2.address, user3.address]);
      expect(await TransferLegacy.getAllAssets()).to.deep.equal([erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS]);
    });

    it("Should emit TransferLegacyCreated event ", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { mainConfig, extraConfig, mainConfigTuple, extraConfigTuple } = await createLegacy(
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS
      );
      const timestamp = await getTimestampOfNextBlock();
      const legacyId = (await TransferWiLegacyuter.legacyId()) + BigInt(1);
      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);

      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig))
        .to.emit(TransferLegacyRouter, "TransferLegacyCreated")
        .withArgs(legacyId, legacyAddress, user1.address, mainConfigTuple, extraConfigTuple, timestamp);
    });

    it("Should handle case of duplicate user in asset distribution config", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom", "Dad"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [20, 50, 100],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [10, 40],
          },
        ],
      };
      const newLegacyId = (await TransferLegacyRouter.legacyId()) + BigInt(1);
      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const legacyCountByUser = (await TransferWiLegacyuter.legacyCountByUsers(user1.address)) + BigInt(1);
      const nonceByUser = (await TransferLegacyRouter.nonceByUsers(user1.address)) + BigInt(1);

      await TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      // Router state
      expect(await TransferLegacyRouter.legacyId()).to.equal(newWiLegacy);
      expect(await TransferLegacyRouter.legacyAddresses(newWiLegacy)).to.equal(legacyAddress);
      expect(await TransferLegacyRouter.legacyCountByUsers(user1.address)).to.equal(legacyCountByUser);
      expect(await TransferLegacyRouter.nonceByUsers(user1.address)).to.equal(nonceByUser);
      // Legacy state
      expect(await TransferLegacy.getLegacyInfo()).to.deep.equal([newLegacyId, user1.address, 1]);
      expect(await TransferLegacy.getActivationTrigger()).to.equal(2);
      expect(await TransferLegacy.minRequiredSignatures()).to.equal(1);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(10);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(80);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(40);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(100);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(0);
      expect(await TransferLegacy.getBeneficiaries()).to.deep.equal([user2.address, user3.address]);
      expect(await TransferLegacy.getAllAssets()).to.deep.equal([erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS]);
    });

    it("Should handle case of duplicate asset in asset distribution config", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS, erc20Contract1.target],
            percents: [20, 50, 100, 40],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target, erc20Contract1.target],
            percents: [80, 50, 60],
          },
        ],
      };
      const newLegacyId = (await TransferLegacyRouter.legacyId()) + BigInt(1);
      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const legacyCountByUser = (await TransferWiLegacyuter.legacyCountByUsers(user1.address)) + BigInt(1);
      const nonceByUser = (await TransferLegacyRouter.nonceByUsers(user1.address)) + BigInt(1);

      await TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      // Router state
      expect(await TransferLegacyRouter.legacyId()).to.equal(newWiLegacy);
      expect(await TransferLegacyRouter.legacyAddresses(newWiLegacy)).to.equal(legacyAddress);
      expect(await TransferLegacyRouter.legacyCountByUsers(user1.address)).to.equal(legacyCountByUser);
      expect(await TransferLegacyRouter.nonceByUsers(user1.address)).to.equal(nonceByUser);
      // Legacy state
      expect(await TransferLegacy.getLegacyInfo()).to.deep.equal([newLegacyId, user1.address, 1]);
      expect(await TransferLegacy.getActivationTrigger()).to.equal(2);
      expect(await TransferLegacy.minRequiredSignatures()).to.equal(1);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(40);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(60);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(100);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(0);
      expect(await TransferLegacy.getBeneficiaries()).to.deep.equal([user2.address, user3.address]);
      expect(await TransferLegacy.getAllAssets()).to.deep.equal([erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS]);
    });

    // Unhappy cases
    it("Should revert if asset percentages are greater than 100", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [21, 50, 100],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "InvalidPercent"
      );
    });

    it("Should revert if beneficiary limit is reached", async function () {
      const { deployer, user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [20, 50, 100],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };
      // Set beneficiary limit
      await TransferLegacyRouter.connect(deployer).setBeneficiaryLimit(1);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacyRouter,
        "BeneficiaryLimitExceeded"
      );
    });

    it("Should revert if min required signatures > number of beneficiaries", async function () {
      const { user1, user2, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom", "Dad"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [20, 50, 100],
          },
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [50, 30],
          },
        ],
      };
      const extraConfig: TransferLegacyStruct.LegacyExtraConfigStruct = {
        minRequiredSignatures: 2,
        lackOfOutgoingTxRange: 2,
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "MinRequiredSignaturesInvalid"
      );
    });

    it("Should revert if assets array and percents array length mismatch", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [20, 50],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "TwoArrayLengthMismatch"
      );
    });

    it("Should revert if beneficiary is address 0", async function () {
      const { user1, user2, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
            percents: [20, 50, 100],
          },
          {
            user: ethers.ZeroAddress,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "BeneficiaryInvalid"
      );
    });

    it("Should revert if assets array is empty", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [20, 50],
          },
          {
            user: user3,
            assets: [],
            percents: [],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "EmptyArray"
      );
    });

    it("Should revert if percent = 0", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [20, 0],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "InvalidPercent"
      );
    });

    it("Should revert if percent > 100", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [20, 101],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "InvalidPercent"
      );
    });

    it("Should revert if asset is not in Whitelist", async function () {
      const { deployer, user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, erc20Whitelist } = await loadFixture(
        deployRouterFixture
      );
      const mainConfig: TransferLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        distributions: [
          {
            user: user2.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [20, 50],
          },
          {
            user: user3.address,
            assets: [erc20Contract1.target, erc20Contract2.target],
            percents: [80, 50],
          },
        ],
      };
      await erc20Whitelist.connect(deployer).updateWhitelist([erc20Contract1.target], false);

      const legacyAddress = await TransferWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const TransferLegacy = await getLegacyContract(legacyAddress);
      await expect(TransferLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        TransferLegacy,
        "ERC20NotInWhitelist"
      );
    });

    it("Should revert if legacy limit is reached", async function () {
      const { deployer, user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );
      await TransferLegacyRouter.connect(deployer).setLegacyLimit(2);
      await createLegacy(user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      await createLegacy(user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      await expect(createLegacy(user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS)).to.be.revertedWithCustomError(
        TransferLegacyRouter,
        "LegacyLimitExceeded"
      );
    });
  });

  /* Delete legacy */
  describe("Delete legacy", function () {
    // Happy cases
    it("Should change router state", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId } = await createWiLegacyser1, user2, user3, TransferWiLegacyuter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      expect(await TransferLegacyRouter.legacyCountByUsers(user1.address)).to.equal(1);
      expect(await TransferLegacyRouter.nonceByUsers(user1.address)).to.equal(1);

      await TransferLegacyRouter.connect(user1).deleteLegacy(legacyId);
      expect(await TransferLegacyRouter.legacyCountByUsers(user1.address)).to.equal(0);
      expect(await TransferLegacyRouter.nonceByUsers(user1.address)).to.equal(1);
    });

    it("Should change Transfer legacy state", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacy
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS,
        etherAmount
      );
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(etherAmount);

      await expect(TransferLegacyRouter.connect(user1).deleteLegacy(legacyId)).to.changeEtherBalance(user1, etherAmount);
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(0);

      const TransferLegacy = await getLegacyContract(legacyAddress);
      expect(await TransferLegacy.getLegacyInfo()).to.deep.equal([legacyId, user1.address, 0]);
      expect(await TransferLegacy.getBeneficiaries()).to.deep.equal([]);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(0);
    });

    it("Should emit TransferLegacyDeleted event", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId } = await createWiLegacyser1, user2, user3, TransferWiLegacyuter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const timestamp = await getTimestampOfNextBlock();

      await expect(TransferLegacyRouter.connect(user1).deleteLegacy(legacyId))
        .to.emit(TransferLegacyRouter, "TransferLegacyDeleted")
        .withArgs(legacyId, user1.address, timestamp);
    });

    // Unhappy cases
    it("Should revert if legacy does not exist", async function () {
      const { user1, TransferLegacyRouter } = await loadFixture(deployRouterFixture);

      await expect(TransferLegacyRouter.connect(user1).deleteLegacy(1)).to.be.revertedWithCustomError(TransferLegacyRouter, "LegacyNotFound");
    });

    it("Should revert if sender is not owner", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      await createLegacy(user2, user1, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await expect(TransferLegacyRouter.connect(user2).deleteLegacy(legacyId)).to.be.revertedWithCustomError(TransferWiLegacy"OnlyOwner");
    });

    it("Should revert if legacy is not activated", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      await createLegacy(user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await TransferLegacyRouter.connect(user1).deleteLegacy(legacyId);
      await expect(TransferLegacyRouter.connect(user1).deleteLegacy(legacyId)).to.be.revertedWithCustomError(TransferWiLegacy"WiLegacytActive");
    });

    it("Should revert if sender is not router", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyAddress } = await createWiLegacyser1, user2, user3, TransferWiLegacyuter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await expect(TransferLegacy.connect(user1).deleteLegacy(user1.address)).to.be.revertedWithCustomError(TransferLegacy, "OnlyRouter");
    });
  });

  /* Withdraw ETH from the legacy */
  describe("Withdraw ETH", function () {
    it("Should withdraw ETH to the owner", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacy
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS,
        etherAmount
      );

      const withdrawAmount = ethers.parseEther("0.5");
      await expect(TransferLegacyRouter.connect(user1).withdrawEthFromLegacy(legacyId, withdrawAmount)).to.changeEtherBalances(
        [user1, legacyAddress],
        [withdrawAmount, withdrawAmount - etherAmount]
      );
    });

    it("Should revert if legacy not enough balance", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacy
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS,
        etherAmount
      );
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await expect(TransferLegacyRouter.connect(user1).withdrawEthFromLegacy(legacyId, etherAmount + BigInt(1))).to.be.revertedWithCustomError(
        TransferLegacy,
        "NotEnoughEther"
      );
    });

    it("Should revert if sender is not owner", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacy
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS,
        etherAmount
      );
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await expect(TransferLegacyRouter.connect(user2).withdrawEthFromLegacy(legacyId, etherAmount)).to.be.revertedWithCustomError(
        TransferLegacy,
        "OnlyOwner"
      );
    });
  });

  /* Update legacy asset distribution */
  describe("Update legacy asset distribution", function () {
    it("Should update asset distribution", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [30, 40, 50],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [70, 60, 50],
        },
      ];
      await TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom"], assetsDistribution, 2);

      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(30);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(70);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(40);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(60);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(50);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(50);
    });

    it("Should update beneficiaries", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target],
          percents: [0, 40],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [70, 60, 50],
        },
        {
          user: user2.address,
          assets: [erc20Contract2.target, ETH_ADDRESS],
          percents: [0, 0],
        },
      ];
      await TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom", "Dad"], assetsDistribution, 1);

      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(erc20Contract1.target, user3.address)).to.equal(70);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(erc20Contract2.target, user3.address)).to.equal(60);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user2.address)).to.equal(0);
      expect(await TransferLegacy.assetsDistribution(ETH_ADDRESS, user3.address)).to.equal(50);
      expect(await TransferLegacy.getBeneficiaries()).to.deep.equal([user3.address]);
      expect(await TransferLegacy.minRequiredSignatures()).to.equal(1);
    });

    it("Should revert if not have any beneficiary", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [0, 0, 0],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [0, 0, 0],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom"], assetsDistribution, 1)
      ).to.be.revertedWithCustomError(TransferLegacy, "NotHaveAnyBeneficiaries");
    });

    it("Should revert if beneficiary is creator", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user1.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom"], assetsDistribution, 1)
      ).to.be.revertedWithCustomError(TransferLegacy, "BeneficiaryInvalid");
    });

    it("Should revert if beneficiary is address 0", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: ethers.ZeroAddress,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom"], assetsDistribution, 1)
      ).to.be.revertedWithCustomError(TransferLegacy, "BeneficiaryInvalid");
    });

    it("Should revert if asset percentages > 100", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user2.address,
          assets: [erc20Contract2.target],
          percents: [90],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom", "Dad"], assetsDistribution, 1)
      ).to.be.revertedWithCustomError(TransferLegacy, "InvalidPercent");
    });

    it("Should revert if min required signatures > number of beneficiaries", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom", "Dad"], assetsDistribution, 3)
      ).to.be.revertedWithCustomError(TransferLegacy, "MinRequiredSignaturesInvalid");
    });

    it("Should revert if beneficiary limit is reached", async function () {
      const { deployer, user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );

      const { legacyId } = await createWiLegacyser1, user2, user3, TransferWiLegacyuter, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      await TransferLegacyRouter.connect(deployer).setBeneficiaryLimit(1);

      const assetsDistribution: TransferLegacyStruct.AssetDistributionStruct[] = [
        {
          user: user2.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
        {
          user: user3.address,
          assets: [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS],
          percents: [20, 20, 20],
        },
      ];
      await expect(
        TransferLegacyRouter.connect(user1).updateLegacyAssetsDistribution(legacyId, ["Dad", "Mom"], assetsDistribution, 1)
      ).to.be.revertedWithCustomError(TransferLegacyRouter, "BeneficiaryLimitExceeded");
    });
  });

  /* Active legacy */
  describe("Active legacy", function () {
    async function signByBeneficiary(beneficiary: any, legacyId: bigint, owner: any) {
      const message = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "uint256", "address", "address"],
        [31337, 2, legacyId, owner.address, beneficiary.address]
      );
      return beneficiary.signMessage(ethers.toBeArray(message));
    }
    it("Should active legacy", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress, mainConfig } = await createLegacyLegacy
        user1,
        user2,
        user3,
        TransferLegacyRouter,
        erc20Contract1,
        erc20Contract2,
        ETH_ADDRESS,
        etherAmount
      );

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];
      const erc20Addresses = [erc20Contract1.target, erc20Contract2.target, ETH_ADDRESS];

      // Mint erc20 token
      const [mintAmount1, mintAmount2] = [ethers.parseEther("100"), ethers.parseEther("100")];
      await erc20Contract1.connect(user1).mint(user1.address, mintAmount1);
      await erc20Contract2.connect(user1).mint(user1.address, mintAmount2);
      // Approve erc20 token
      const [approveAmount1, approveAmount2] = [ethers.parseEther("50"), ethers.parseEther("150")];
      await erc20Contract1.connect(user1).approve(legacyAddress, approveAmount1);
      await erc20Contract2.connect(user1).approve(legacyAddress, approveAmount2);
      const transferAmount1 = mintAmount1 > approveAmount1 ? approveAmount1 : mintAmount1;
      const transferAmount2 = mintAmount2 > approveAmount2 ? approveAmount2 : mintAmount2;
      // Received amount
      const [distribution1, distribution2] = mainConfig.distributions;
      const amount1User2 = (BigInt(distribution1.percents[0]) * transferAmount1) / BigInt(100);
      const amount2User2 = (BigInt(distribution1.percents[1]) * transferAmount2) / BigInt(100);
      const amount3User2 = (BigInt(distribution1.percents[2]) * etherAmount) / BigInt(100);
      const amount1User3 = (BigInt(distribution2.percents[0]) * transferAmount1) / BigInt(100);
      const amount2User3 = (BigInt(distribution2.percents[1]) * transferAmount2) / BigInt(100);

      const timestamp = await getTimestampOfNextBlock();

      await expect(TransferLegacyRouter.connect(user2).activeLegacy(legacyId, signatures[0]))
        .to.emit(TransferLegacyRouter, "TransferLegacyActivated")
        .withArgs(legacyId, etherAmount, erc20Addresses, [transferAmount1, transferAmount2, 0], timestamp);

      expect(await erc20Contract1.balanceOf(user1.address)).to.equal(mintAmount1 - transferAmount1);
      expect(await erc20Contract2.balanceOf(user1.address)).to.equal(mintAmount2 - transferAmount2);
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(etherAmount - amount3User2);

      expect(await erc20Contract1.balanceOf(user2.address)).to.equal(amount1User2);
      expect(await erc20Contract2.balanceOf(user2.address)).to.equal(amount2User2);
      expect(await ethers.provider.getBalance(user2.address)).to.changeEtherBalance(user2.address, amount3User2);

      expect(await erc20Contract1.balanceOf(user3.address)).to.equal(amount1User3);
      expect(await erc20Contract2.balanceOf(user3.address)).to.equal(amount2User3);
    });

    it("Should revert if sender is not beneficiary", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1)];
      const erc20Addresses = [erc20Contract1.target, erc20Contract2.target];

      await expect(
        TransferLegacyRouter.connect(user1).activeLegacy(legacyId, signatures[0])
      ).to.be.revertedWithCustomError(TransferLegacy, "NotBeneficiary");
    });

    it("Should revert if beneficiary signature invalid", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1)];
      const erc20Addresses = [erc20Contract1.target, erc20Contract2.target];

      await expect(
        TransferLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[0])
      ).to.be.revertedWithCustomError(TransferLegacy, "SignatureInvalid");
    });

    it("Should revert if legacy is not active", async function () {
      const { user1, user2, user3, TransferLegacyRouter, erc20Contract1, erc20Contract2, ETH_ADDRESS } = await loadFixture(
        deployRouterFixture
      );

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, TransferLegacyLegacyer, erc20Contract1, erc20Contract2, ETH_ADDRESS);
      const TransferLegacy = await getLegacyContract(legacyAddress);

      await TransferLegacyRouter.connect(user1).deleteLegacy(legacyId);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1)];
      const erc20Addresses = [erc20Contract1.target, erc20Contract2.target];

      await expect(
        TransferLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[0])
      ).to.be.revertedWithCustomError(TransferLegacy, "LegacyNotActive");
    });
  });
});
