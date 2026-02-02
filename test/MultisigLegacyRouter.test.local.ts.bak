import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MultisigLegacy, MultisigLegacyRouter } from "../typechain-types";
import { MultisigLegacyStruct } from "../typechain-types/contracts/MultisigLegacy";

describe("MultisigLegacyRouter", function () {
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
    // Deploy MultisigLegacyRouter
    const MultisigLegacyRouter = await ethers.deployContract("MultisigLegacyRouter", [0, feeReceiver.address, 0, erc20Whitelist.target], deployer);
    await MultisigLegacyRouter.waitForDeployment();
    await MultisigLegacyRouter.connect(deployer).addOperator(operator.address);

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
      MultisigLegacyRouter,
    };
  }

  /* Deployment */
  describe("Deployment", function () {
    it("Should set the right admin", async function () {
      const { deployer, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const ADMIN_ROLE = await MultisigLegacyRouter.DEFAULT_ADMINOLE();
      expect(await MultisigLegacyRouter.hasRole(ADMIN_ROLE, deployer.address)).to.be.true;
    });

    it("Should set the right configures", async function () {
      const { feeReceiver, erc20Whitelist, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      expect(await MultisigLegacyRouter.legacyFee()).to.equal(0);
      expect(await MultisigLegacyRouter.feeReceiver()).to.equal(feeReceiver.address);
      expect(await MultisigLegacyRouter.legacyLimit()).to.equal(0);
      expect(await MultisigLegacyRouter.erc20Whitelist()).to.equal(erc20Whitelist.target);
    });
  });

  async function getLegacyContract(legacyAddress: string) {
    const legacyFactory = await ethers.getContractFactory("MultisigWiLegacy;
    const MultisigLegacy: MultisigLegacy = legacyFactory.attach(legacyAddress) as any;
    return MultisigLegacy;
  }

  const extraConfig: MultisigLegacyStruct.LegacyExtraConfigStruct = {
    minRequiredSignatures: 2,
    lackOfOutgoingTxRange: 2,
  };

  async function createLegacy(
    user1: any,
    user2: any,
    user3: any,
    MultisigLegacyRouter: MultisigLegacyRouter,
    value: bigint = BigInt(0),
    assets: string[] = []
  ) {
    const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
      name: "My legacy",
      note: "For my family",
      nickNames: ["Dad", "Mom"],
      beneficiaries: [user2.address, user3.address],
      assets,
    };
    const mainConfigTuple = [mainConfig.name, mainConfig.note, mainConfig.nickNames, mainConfig.beneficiaries, mainConfig.assets];
    const extraConfigTuple = [extraConfig.minRequiredSignatures, extraConfig.lackOfOutgoingTxRange];

    const legacyAddress = await MultisigWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
    await MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig, { value });
    const legacyId = await MultisigWiLegacyuter.legacyId();

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
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const newLegacyId = (await MultisigLegacyRouter.legacyId()) + BigInt(1);
      const legacyAddress = await MultisigWiLegacyuter.getNextWiLegacydressOfUser(user1.address);
      const legacyCountByUser = (await MultisigWiLegacyuter.legacyCountByUsers(user1.address)) + BigInt(1);
      const nonceByUser = (await MultisigLegacyRouter.nonceByUsers(user1.address)) + BigInt(1);

      await createLegacy(user1, user2, user3, MultisigLegacyRouter);

      expect(await MultisigLegacyRouter.legacyId()).to.equal(newWiLegacy);
      expect(await MultisigLegacyRouter.legacyAddresses(newWiLegacy)).to.equal(legacyAddress);
      expect(await MultisigLegacyRouter.legacyCountByUsers(user1.address)).to.equal(legacyCountByUser);
      expect(await MultisigLegacyRouter.nonceByUsers(user1.address)).to.equal(nonceByUser);
    });

    it("Should change Multisig legacy state", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      expect(await legacy.getWiLegacyfo()).to.deep.equal([legacyId, user1.address, 1]);
      expect(await legacy.getActivationTrigger()).to.equal(extraConfig.lackOfOutgoingTxRange);
      expect(await legacy.minRequiredSignatures()).to.equal(extraConfig.minRequiredSignatures);
      expect(await legacy.getBeneficiaries()).to.deep.equal([user2.address, user3.address]);
    });

    it("Should emit MultisigLegacyCreated event ", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { mainConfig, extraConfig, mainConfigTuple, extraConfigTuple } = await createLegacy(user1, user2, user3, MultisigLegacyRouter);
      const timestamp = await getTimestampOfNextBlock();
      const legacyId = (await MultisigWiLegacyuter.legacyId()) + BigInt(1);
      const legacyAddress = await MultisigWiLegacyuter.getNextWiLegacydressOfUser(user1.address);

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig))
        .to.emit(MultisigLegacyRouter, "MultisigLegacyCreated")
        .withArgs(legacyId, legacyAddress, user1.address, mainConfigTuple, extraConfigTuple, timestamp);
    });

    // Unhappy cases
    it("Should revert if nickname length is not equal to beneficiaries length", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad"],
        beneficiaries: [user2.address, user3.address],
        assets: [],
      };

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        MultisigLegacyRouter,
        "TwoArraysLengthMismatch"
      );
    });

    it("Should revert if min required signatures > number of beneficiaries", async function () {
      const { user1, user2, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom", "Mom"],
        beneficiaries: [user2.address, user2.address, user2.address],
        assets: [],
      };
      const legacy = await getWiLegacyntract(user1.address);

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        legacy,
        "MinRequiredSignaturesInvalid"
      );
    });

    it("Should revert if beneficiary is address 0", async function () {
      const { user1, user2, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        beneficiaries: [user2.address, ethers.ZeroAddress],
        assets: [],
      };
      const legacy = await getWiLegacyntract(user1.address);

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        legacy,
        "BeneficiaryInvalid"
      );
    });

    it("Should revert if beneficiary is owner", async function () {
      const { user1, user2, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        beneficiaries: [user2.address, user1.address],
        assets: [],
      };
      const legacy = await getWiLegacyntract(user1.address);

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        legacy,
        "BeneficiaryInvalid"
      );
    });

    it("Should revert if not enough ether to pay fee", async function () {
      const { deployer, user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);
      const etherAmount = ethers.parseEther("1");
      await MultisigLegacyRouter.connect(deployer).setFee(etherAmount);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        beneficiaries: [user2.address, user3.address],
        assets: [],
      };

      await expect(
        MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig, { value: ethers.parseEther("0.9") })
      ).to.be.revertedWithCustomError(MultisigLegacyRouter, "NotEnoughEther");
    });

    it("Should revert if beneficiary limit is reached", async function () {
      const { deployer, user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);
      await MultisigLegacyRouter.connect(deployer).setBeneficiaryLimit(1);

      const mainConfig: MultisigLegacyRouter.LegacyMainConfigStruct = {
        name: "My legacy",
        note: "For my family",
        nickNames: ["Dad", "Mom"],
        beneficiaries: [user2.address, user3.address],
        assets: [],
      };

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        MultisigLegacyRouter,
        "BeneficiaryLimitExceeded"
      );
    });

    it("Should revert if legacy limit is reached", async function () {
      const { deployer, user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);
      await MultisigLegacyRouter.connect(deployer).setLegacyLimit(2);

      const { mainConfig } = await createLegacy(user1, user2, user3, MultisigLegacyRouter);
      await createLegacy(user1, user2, user3, MultisigLegacyRouter);

      await expect(MultisigLegacyRouter.connect(user1).createLegacy(mainConfig, extraConfig)).to.be.revertedWithCustomError(
        MultisigLegacyRouter,
        "LegacyLimitExceeded"
      );
    });

    it("Should revert if legacy is initialized", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Whitelist } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress, mainConfig, extraConfig } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(
        legacy.connect(user1).initialize(legacyId, user1.address, erc20Whitelist.target, mainConfig.beneficiaries, mainConfig.assets, extraConfig)
      ).to.be.revertedWithCustomError(legacy, "WiLegacyreadyInitialized");
    });
  });

  /* Delete legacy */
  describe("Delete legacy", function () {
    // Happy cases
    it("Should change router state", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId } = await createWiLegacyser1, user2, user3, MultisigWiLegacyuter);
      expect(await MultisigLegacyRouter.legacyCountByUsers(user1.address)).to.equal(1);
      expect(await MultisigLegacyRouter.nonceByUsers(user1.address)).to.equal(1);

      await MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId);
      expect(await MultisigLegacyRouter.legacyCountByUsers(user1.address)).to.equal(0);
      expect(await MultisigLegacyRouter.nonceByUsers(user1.address)).to.equal(1);
    });

    it("Should change Multisig legacy state", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount);
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(etherAmount);

      await expect(MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId)).to.changeEtherBalance(user1, etherAmount);
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(0);

      const legacy = await getWiLegacyntract(legacyAddress);
      expect(await legacy.getWiLegacyfo()).to.deep.equal([legacyId, user1.address, 0]);
      expect(await legacy.getBeneficiaries()).to.deep.equal([]);
    });

    it("Should emit MultisigLegacyDeleted event", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId } = await createWiLegacyser1, user2, user3, MultisigWiLegacyuter);
      const timestamp = await getTimestampOfNextBlock();

      await expect(MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId))
        .to.emit(MultisigLegacyRouter, "MultisigLegacyDeleted")
        .withArgs(legacyId, user1.address, timestamp);
    });

    // Unhappy cases
    it("Should revert if legacy does not exist", async function () {
      const { user1, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      await expect(MultisigLegacyRouter.connect(user1).deleteLegacy(1)).to.be.revertedWithCustomError(MultisigLegacyRouter, "LegacyNotFound");
    });

    it("Should revert if sender is not owner", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      await createLegacy(user2, user1, user3, MultisigLegacyRouter);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(MultisigLegacyRouter.connect(user2).deleteLegacy(legacyId)).to.be.revertedWithCustomError(legacy, "OnlyOwner");
    });

    it("Should revert if legacy is not activated", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      await createLegacy(user1, user2, user3, MultisigLegacyRouter);
      const legacy = await getWiLegacyntract(legacyAddress);

      await MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId);
      await expect(MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId)).to.be.revertedWithCustomError(legacy, "LegacyLegacyctive");
    });

    it("Should revert if sender is not router", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyAddress } = await createWiLegacyser1, user2, user3, MultisigWiLegacyuter);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(legacy.connect(user1).deleteWiLegacyser1.address)).to.be.revertedWithCustomError(legacy, "OnlyRouter");
    });
  });

  /* Withdraw ETH from the legacy */
  describe("Withdraw ETH", function () {
    it("Should withdraw ETH to the owner", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount);

      const withdrawAmount = ethers.parseEther("0.5");
      await expect(MultisigLegacyRouter.connect(user1).withdrawEthFromLegacy(legacyId, withdrawAmount)).to.changeEtherBalances(
        [user1, legacyAddress],
        [withdrawAmount, withdrawAmount - etherAmount]
      );
    });

    it("Should revert if legacy not enough balance", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(MultisigLegacyRouter.connect(user1).withdrawEthFromLegacy(legacyId, etherAmount + BigInt(1))).to.be.revertedWithCustomError(
        legacy,
        "NotEnoughEther"
      );
    });

    it("Should revert if sender is not owner", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(MultisigLegacyRouter.connect(user2).withdrawEthFromLegacy(legacyId, etherAmount)).to.be.revertedWithCustomError(legacy, "OnlyOwner");
    });
  });

  /* Update beneficiaries */
  describe("Update beneficiaries", function () {
    it("Should update beneficiaries", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);
      const timestamp = await getTimestampOfNextBlock();

      await expect(MultisigLegacyRouter.connect(user1).setLegacyBeneficiaries(legacyId, ["Dad"], [user2.address], 1))
        .to.emit(MultisigLegacyRouter, "MultisigLegacyBeneficiaryUpdated")
        .withArgs(legacyId, ["Dad"], [user2.address], 1, timestamp);
      expect(await legacy.getBeneficiaries()).to.deep.equal([user2.address]);
    });
    it("Should revert if beneficiary is address 0", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(
        MultisigLegacyRouter.connect(user1).setLegacyBeneficiaries(legacyId, ["Dad", "Mom"], [user2.address, ethers.ZeroAddress], 1)
      ).to.be.revertedWithCustomError(legacy, "BeneficiaryInvalid");
    });
    it("Should revert if beneficiary is owner", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(
        MultisigLegacyRouter.connect(user1).setLegacyBeneficiaries(legacyId, ["Dad", "Mom"], [user2.address, user1.address], 1)
      ).to.be.revertedWithCustomError(legacy, "BeneficiaryInvalid");
    });
    it("Should revert if min required signatures > number of beneficiaries", async function () {
      const { user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      await expect(
        MultisigLegacyRouter.connect(user1).setLegacyBeneficiaries(legacyId, ["Dad", "Mom"], [user2.address, user2.address], 2)
      ).to.be.revertedWithCustomError(legacy, "MinRequiredSignaturesInvalid");
    });
    it("Should revert if beneficiary limit is reached", async function () {
      const { deployer, user1, user2, user3, MultisigLegacyRouter } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);
      await MultisigLegacyRouter.connect(deployer).setBeneficiaryLimit(1);

      await expect(
        MultisigLegacyRouter.connect(user1).setLegacyBeneficiaries(legacyId, ["Dad", "Mom"], [user2.address, user3.address], 1)
      ).to.be.revertedWithCustomError(MultisigLegacyRouter, "BeneficiaryLimitExceeded");
    });
  });

  /* Active legacy */
  async function signByBeneficiary(beneficiary: any, legacyId: bigint, owner: any) {
    const message = ethers.solidityPackedKeccak256(
      ["uint256", "uint256", "uint256", "address", "address"],
      [31337, 1, legacyId, owner.address, beneficiary.address]
    );
    return beneficiary.signMessage(ethers.toBeArray(message));
  }

  describe("Active legacy", function () {
    it("Should active legacy", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const erc20Addresses: string[] = [erc20Contract1.target.toString(), erc20Contract2.target.toString()];
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount, erc20Addresses);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];

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

      await (await MultisigLegacyRouter.connect(user2).activeLegacy(legacyId, signatures[0])).wait();

      const timestamp = await getTimestampOfNextBlock();

      await expect(MultisigLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[1]))
        .to.emit(MultisigLegacyRouter, "MultisigLegacyActivated")
        .withArgs(legacyId, etherAmount, erc20Addresses, [transferAmount1, transferAmount2], timestamp);

      expect(await erc20Contract1.balanceOf(user1.address)).to.equal(mintAmount1 - transferAmount1);
      expect(await erc20Contract2.balanceOf(user1.address)).to.equal(mintAmount2 - transferAmount2);
      expect(await ethers.provider.getBalance(legacyAddress)).to.equal(0);

      expect(await erc20Contract1.balanceOf(user2.address)).to.equal(transferAmount1 / BigInt(2));
      expect(await erc20Contract2.balanceOf(user2.address)).to.equal(transferAmount2 / BigInt(2));
      expect(await erc20Contract1.balanceOf(user3.address)).to.equal(transferAmount1 / BigInt(2));
      expect(await erc20Contract2.balanceOf(user3.address)).to.equal(transferAmount2 / BigInt(2));
      expect(await ethers.provider.getBalance(user2.address)).to.changeEtherBalance(
        [user2.address, user3.address],
        [etherAmount / BigInt(2), etherAmount / BigInt(2)]
      );
    });

    it("Not enough signature", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);

      const etherAmount = ethers.parseEther("1");
      const erc20Addresses: string[] = [erc20Contract1.target.toString(), erc20Contract2.target.toString()];
      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer, etherAmount, erc20Addresses);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];

      // Mint erc20 token
      const [mintAmount1, mintAmount2] = [ethers.parseEther("100"), ethers.parseEther("100")];
      await erc20Contract1.connect(user1).mint(user1.address, mintAmount1);
      await erc20Contract2.connect(user1).mint(user1.address, mintAmount2);
      // Approve erc20 token
      const [approveAmount1, approveAmount2] = [ethers.parseEther("50"), ethers.parseEther("150")];
      await erc20Contract1.connect(user1).approve(legacyAddress, approveAmount1);
      await erc20Contract2.connect(user1).approve(legacyAddress, approveAmount2);

      const timestamp = await getTimestampOfNextBlock();

      await expect(MultisigLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[1]))
        .to.emit(MultisigLegacyRouter, "MultisigLegacyActivated")
        .withArgs(legacyId, 0, erc20Addresses, [0, 0], timestamp);
    });

    it("Should revert if sender is not beneficiary", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];

      await expect(MultisigLegacyRouter.connect(user1).activeLegacy(legacyId, signatures[0])).to.be.revertedWithCustomError(legacy, "NotBeneficiary");
    });

    it("Should revert if beneficiary signature invalid", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];

      await expect(MultisigLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[0])).to.be.revertedWithCustomError(legacy, "SignatureInvalid");
    });

    it("Should revert if legacy is not active", async function () {
      const { user1, user2, user3, MultisigLegacyRouter, erc20Contract1, erc20Contract2 } = await loadFixture(deployRouterFixture);

      const { legacyId, legacyAddress } = await createLegacyLegacyr1, user2, user3, MultisigLegacyLegacyer);
      const legacy = await getWiLegacyntract(legacyAddress);

      await MultisigLegacyRouter.connect(user1).deleteLegacy(legacyId);

      // Signatures
      const signatures = [await signByBeneficiary(user2, legacyId, user1), await signByBeneficiary(user3, legacyId, user1)];

      await expect(MultisigLegacyRouter.connect(user3).activeLegacy(legacyId, signatures[0])).to.be.revertedWithCustomError(legacy, "LegacyLegacyctive");
    });
  });
});
