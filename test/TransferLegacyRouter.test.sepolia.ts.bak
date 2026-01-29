import { ContractRunner } from "ethers";
import { expect } from "chai";
import { ethers } from "hardhat";
import "dotenv/config";

import fs from "fs";
import path from "path";
import SafeApiKit from "@safe-global/api-kit";
import Safe from "@safe-global/protocol-kit";
import {
  MetaTransactionData,
  SafeMultisigTransactionResponse,
  SafeSignature,
  SafeTransaction,
  TransactionResult,
} from "@safe-global/safe-core-sdk-types";
import { TransferLegacy, TransferLegacy__factory, TransferLegacyRouter, TransferLegacyRouter__factory } from "../typechain-types";
import { TransferLegacyStruct } from "../typechain-types/contracts/TransferLegacy";

describe("Transfer Router", function () {
  /* config */
  const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL;
  const CHAIN_ID = process.env.SEPOLIA_CHAIN_ID;
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC_URL);

  const TRANSFER_LEGACY_ROUTER = process.env.TRANSFER_LEGACY_ROUTER as string;
  const SAFEWALLET_SUCEESFULLY = process.env.SAFEWALLET_SUCCESSFULLY as string;
  const SAFEWALLET_LENGTH_TWO_ARRAY = process.env.SAFEWALLET_LENGTH_TWO_ARRAY as string;
  const SAFEWALLET_EXIST_GUARD = process.env.SAFEWALLET_NOT_EXIST_GUARD as string;
  const SAFEWALLET_SIGNER_NOT_OWNER = process.env.SAFEWALLET_SIGNER_NOT_OWNER as string;
  const SAFEWALLET_GUARD_INVALID = process.env.SAFEWALLET_GUARD_INVALID as string;
  const SAFEWALLET_MODULE_INVALID = process.env.SAFEWALLET_MODULE_INVALID as string;
  const ADMIN_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as string;
  const SIGNER1_PRIVATE_KEY = process.env.SIGNER1_PRIVATE_KEY as string;
  const SIGNER2_PRIVATE_KEY = process.env.SIGNER2_PRIVATE_KEY as string;
  const BENEFICIARIES1_PRIVATE_KEY = process.env.BENEFICIARIES1 as string;
  const BENEFICIARIES2_PRIVATE_KEY = process.env.BENEFICIARIES2 as string;
  const BENEFICIARIES3_PRIVATE_KEY = process.env.BENEFICIARIES3 as string;
  const NUM_BENEFICIARIES_LIMIT = process.env.NUM_BENEFICIARIES_LIMIT as string;

  /* Get router contract */
  async function getTransferLegacyRouter() {
    const TransferRouterFactory: TransferLegacyRouter__factory = await ethers.getContractFactory("TransferLegacyRouter");
    const TransferRouterContract: TransferLegacyRouter = TransferRouterFactory.attach(TRANSFER_LEGACY_ROUTER) as TransferLegacyRouter;
    return TransferRouterContract;
  }

  /* Get legacy contract */
  async function getTransferLegacy(legacyAddress: string) {
    const TransferLegacyFactory: TransferLegacy__factory = await ethers.getContractFactory("TransferLegacy");
    const TransferLegacyContract: TransferLegacy = TransferLegacyFactory.attach(legacyAddress) as TransferLegacy;
    return TransferLegacyContract;
  }

  /* Create protocol kit */
  async function getProtocolKit(safeAddress: string, privateKeySigner: string): Promise<Safe> {
    const protocolKit: Safe = await Safe.init({
      provider: SEPOLIA_RPC_URL as string,
      signer: privateKeySigner,
      safeAddress: safeAddress,
    });
    return protocolKit;
  }

  /* Create api kit */
  async function getApiKit(): Promise<SafeApiKit> {
    const apiKit = await new SafeApiKit({
      chainId: BigInt(CHAIN_ID as string),
    });
    return apiKit;
  }

  /* Create transaction data */
  async function getMetaTransactionData(nameFn: string, arg: Object): Promise<MetaTransactionData> {
    const routerAbiJson = getAbi("../artifacts/contracts/TransferLegacyRouter.sol/TransferLegacyRouter.json");
    const routerAbi = new ethers.Interface(routerAbiJson);
    const selector = await routerAbi.encodeFunctionData(nameFn, Object.values(arg));
    const transactionData: MetaTransactionData = {
      to: TRANSFER_LEGACY_ROUTER,
      value: "0",
      data: selector,
    };
    return transactionData;
  }

  /* Create transaction  */
  type CreateTransaction = {
    safeTransaction: SafeTransaction;
    safeTransactionHash: string;
    signature: SafeSignature;
  };

  async function createTransaction(protocolKit: Safe, signer: string, metaTransactionDatas: MetaTransactionData[]): Promise<string> {
    const safeTransaction: SafeTransaction = await protocolKit.createTransaction({
      transactions: metaTransactionDatas,
    });
    const safeTransactionHash: string = await protocolKit.getTransactionHash(safeTransaction);
    const signature: SafeSignature = await protocolKit.signHash(safeTransactionHash);
    const safeAddress: string = await protocolKit.getAddress();
    const apiKit: SafeApiKit = await getApiKit();

    await apiKit.proposeTransaction({
      safeAddress: safeAddress,
      senderAddress: signer,
      safeTxHash: safeTransactionHash,
      safeTransactionData: safeTransaction.data,
      senderSignature: signature.data,
    });
    return safeTransactionHash;
  }

  /* Sign transaction */
  async function signTransaction(protocolKit: Safe, safeTransactionHash: string) {
    const apiKit: SafeApiKit = await getApiKit();
    const signature: SafeSignature = await protocolKit.signHash(safeTransactionHash);
    await apiKit.confirmTransaction(safeTransactionHash, signature.data);
  }

  /* Execute transaction safe wallet */
  async function executeTransaction(protocolKit: Safe, safeTransactionHash: string): Promise<TransactionResult> {
    const apiKit: SafeApiKit = await getApiKit();
    const transaction: SafeMultisigTransactionResponse = await apiKit.getTransaction(safeTransactionHash);
    const tx = await protocolKit.executeTransaction(transaction);
    return tx;
  }

  /* Struct */
  type MainConfig = TransferLegacyRouter.LegacyMainConfigStruct;
  type ExtraConfig = TransferLegacyStruct.LegacyExtraConfigStruct;

  /* Functions */
  async function checkActiveLegacy(legacyId: bigint): Promise<boolean> {
    const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
    const tx = await TransferLegacyRouter.checkActiveLegacy(legacyId);
    return tx;
  }

  async function setBeneficiariesLimit(numBeneficiariesLimit: bigint) {
    const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
    const signer = new ethers.Wallet(ADMIN_PRIVATE_KEY, provider);
    await TransferLegacyRouter.connect(signer).setBeneficiaryLimit(numBeneficiariesLimit);
  }

  async function createLegacy(safeWallet: string, mainConfig: MainConfig, extraConfig: ExtraConfig, signer: ContractRunner) {
    const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
    const tx = await TransferLegacyRouter.connect(signer).createLegacy(safeWallet, mainConfig, extraConfig);
    return tx;
  }

  async function setLegacyConfig(protocolKit: Safe, signer: string, legacyId: bigint, mainConfig: MainConfig, extraConfig: ExtraConfig): Promise<string> {
    type ArgType = {
      legacyId: bigint;
      mainConfig: MainConfig;
      extraConfig: ExtraConfig;
    };
    const arg: ArgType = { legacyId, mainConfig, extraConfig };
    const metaTransactionData: MetaTransactionData = await getMetaTransactionData("setLegacyConfig", arg);
    const safeTransactionHash: string = await createTransaction(protocolKit, signer, [metaTransactionData]);
    return safeTransactionHash;
  }

  async function setLegacyBeneficiaries(
    protocolKit: Safe,
    signer: string,
    legacyId: bigint,
    nicknames: string[],
    beneficiaries: string[],
    minRequiredSignatures: bigint
  ): Promise<string> {
    type ArgType = {
      legacyId: bigint;
      nicknames: string[];
      beneficiaries: string[];
      minRequiredSignatures: bigint;
    };
    const arg: ArgType = { legacyId, nicknames, beneficiaries, minRequiredSignatures };
    const metaTransactionData: MetaTransactionData = await getMetaTransactionData("setLegacyBeneficiaries", arg);
    const safeTransactionHash: string = await createTransaction(protocolKit, signer, [metaTransactionData]);
    return safeTransactionHash;
  }
  async function setActivationTrigger(protocolKit: Safe, signer: string, legacyId: bigint, lackOfOutgoingTxRange: bigint): Promise<string> {
    type ArgType = {
      legacyId: bigint;
      lackOfOutgoingTxRange: bigint;
    };
    const arg: ArgType = { legacyId: legacyId, lackOfOutgoingTxRange };
    const metaTransactionData: MetaTransactionData = await getMetaTransactionData("setActivationTrigger", arg);
    const safeTransactionHash: string = await createTransaction(protocolKit, signer, [metaTransactionData]);
    return safeTransactionHash;
  }
  async function setNameNote(protocolKit: Safe, signer: string, legacyId: bigint, name: string, note: string) {
    type ArgType = {
      legacyId: bigint;
      name: string;
      note: string;
    };
    const arg: ArgType = { legacyId, name, note };
    const metaTransactionData: MetaTransactionData = await getMetaTransactionData("setNameNote", arg);
    const safeTransactionHash: string = await createTransaction(protocolKit, signer, [metaTransactionData]);
    return safeTransactionHash;
  }
  async function activeLegacy(legacyId: bigint, signer: ContractRunner) {
    const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
    const tx = await TransferLegacyRouter.connect(signer).activeLegacy(legacyId);
    return tx;
  }

  /* Utils functions */
  function getAbi(abiPath: string) {
    const dir = path.resolve(__dirname, abiPath);
    const file = fs.readFileSync(dir, "utf-8");
    const json = JSON.parse(file);
    const abi = json.abi;
    return abi;
  }

  async function getLogsTransaction(nameContract: string, transactionHash: string) {
    const abi = getAbi(nameContract);
    const iface = new ethers.Interface(abi);
    const receipt = await provider.getTransactionReceipt(transactionHash);
    receipt?.logs.forEach((log) => {
      console.log(iface.parseLog(log)?.args);
    });
  }

  /* Create Legacy */
  describe("createLegacy", function () {
    it("Should create legacy successfully", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const mainConfig: MainConfig = {
        name: "CW name",
        note: "CW note",
        nickNames: ["CW nickname 1"],
      };

      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 100,
      };
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      //State Expect
      const legacyIdExpect: bigint = (await TransferLegacyRouter._legacyId()) + BigInt(1);
      const legacyAddressExpect: string = await TransferLegacyRouter.getNextLegacyAddress(signer.address);
      const guardAddressExpect: string = await TransferLegacyRouter.getNextGuardAddress(signer.address);
      const nonceByUserExpect: bigint = (await TransferLegacyRouter.nonceByUsers(signer.address)) + BigInt(1);
      const isActiveExpect: bigint = BigInt(1);
      const timestampExpect = 1;

      //Execute
      const tx = await createLegacy(SAFEWALLET_SUCEESFULLY, mainConfig, extraConfig, signer);

      //State After Execute
      const legacyId_: bigint = await TransferLegacyRouter._legacyId();
      const nonceByUser_ = await TransferLegacyRouter.nonceByUsers(signer.address);
      const legacyAddress_: string = await TransferLegacyRouter.legacyAddresses(legacyId_);
      const guardAddress_: string = await TransferLegacyRouter.guardAddresses(legacyId_);
      const legacy_: TransferLegacy = await getTransferLegacy(legacyAddress_);
      const legacyInfo_: [bigint, string, bigint] = await legacy_.getLegacyLegacy();
      const beneficiaries_: string[] = await legacy_.getBeneficiaries();
      const activationTrigger_: bigint = await legacy_.getActivationTrigger();

      //Expect
      expect(legacyId_).to.equal(legacyIdExpect);
      expect(legacyAddress_).to.equal(legacyAddressExpect);
      expect(guardAddress_).to.equal(guardAddressExpect);
      expect(nonceByUser_).to.equal(nonceByUserExpect);
      expect(legacyInfo_[0]).to.equal(legacyIdExpect);
      expect(legacyInfo_[1]).to.equal(SAFEWALLET_SUCEESFULLY);
      expect(legacyInfo_[2]).to.equal(isActiveExpect);
      expect(activationTrigger_).to.equal(extraConfig.lackOfOutgoingTxRange);
      expect(tx)
        .to.emit(TransferLegacyRouter, "MultisigLegacyCreated")
        .withArgs(
          legacyIdExpect,
          legacyAddressExpect,
          guardAddressExpect,
          signer.address,
          SAFEWALLET_SUCEESFULLY,
          mainConfig,
          extraConfig,
          timestampExpect
        );
    });
    it("Should revert if length of beneficiaries list difference length of nicknames list ", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const mainConfig: MainConfig = {
        name: "CW name",
        note: "CW note",
        nickNames: ["CW nickname 1", "CW nickname2", "CW nickname3"],
      };

      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 100,
      };
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      //Execute
      const tx = await createLegacy(SAFEWALLET_LENGTH_TWO_ARRAY, mainConfig, extraConfig, signer);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "TwoArraysLengthMismatch");
    });
    it("Should revert if not existed beneficiarires", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const mainConfig: MainConfig = {
        name: "CW name",
        note: "CW note",
        nickNames: [],
      };

      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 100,
      };
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      //Execute
      const tx = await createLegacy(SAFEWALLET_SUCEESFULLY, mainConfig, extraConfig, signer);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "EmptyArray");
    });
    it("Should revert if number of beneficiaries > beneficiariesLimit", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const beneficiaries3 = new ethers.Wallet(BENEFICIARIES3_PRIVATE_KEY, provider);
      const mainConfig: MainConfig = {
        name: "CW name",
        note: "CW note",
        nickNames: ["CW nickname1", "CW nickname2", "CW nickname3"],
        beneficiaries: [beneficiaries1.address, beneficiaries2.address, beneficiaries3.address],
      };

      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 100,
      };
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const numBeneficiariesLimit: number = mainConfig.beneficiaries.length - 1;

      //Execute
      await setBeneficiariesLimit(BigInt(numBeneficiariesLimit));
      const tx = await createLegacy(SAFEWALLET_SUCEESFULLY, mainConfig, extraConfig, signer);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "BeneficiaryLimitExceeded");
    });
    it("Should revert if safe wallet existed guard ", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const mainConfig: MainConfig = {
        name: "CW name",
        note: "CW note",
        nickNames: ["CW nickname 1"],
      };

      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 100,
      };
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      //Execute
      const tx = await createLegacy(SAFEWALLET_EXIST_GUARD, mainConfig, extraConfig, signer);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "ExistedGuardInSafeWallet").withArgs(SAFEWALLET_EXIST_GUARD);
    });
  });

  it("Should revert if signer is not owner of safe wallet ", async function () {
    const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
    //Input
    const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
    const mainConfig: MainConfig = {
      name: "CW name",
      note: "CW note",
      nickNames: ["CW nickname 1"],
    };

    const extraConfig: ExtraConfig = {
      lackOfOutgoingTxRange: 100,
    };
    const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

    //Execute
    const tx = await createLegacy(SAFEWALLET_SIGNER_NOT_OWNER, mainConfig, extraConfig, signer);

    //Expect
    expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "SignerIsNotOwnerOfSafeWallet");
  });

  /* Set Legacy Config */
  describe("setLegacyConfig", function () {
    it("Should update legacy config successfully", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: ["SWC nickname1", "SWC nickname2"],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };

      const legacyAddress: string = await TransferLegacyRouter.legacyAddresses(legacyId);
      const legacy: TransferLegacy = await getTransferLegacy(legacyAddress);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //State Expect
      const timestampExpect = 1;

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //State After Execute
      const beneficiaries_: string[] = await legacy.getBeneficiaries();
      const activationTrigger_: bigint = await legacy.getActivationTrigger();

      //Expect
      expect(activationTrigger_).to.equal(extraConfig.lackOfOutgoingTxRange);

      expect(tx).to.emit(TransferLegacyRouter, "TransferLegacyConfigUpdated").withArgs(legacyId, mainConfig, extraConfig, timestampExpect);
    });
    it("Should revert if guard of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: ["SWC nickname1", "SWC nickname2"],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "GuardSafeWalletInvalid");
    });

    it("Should revert if module of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: ["SWC nickname1", "SWC nickname2"],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "ModuleSafeWalletInvalid");
    });

    it("Should revert if length of beneficiaries list difference length of nicknames list", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: ["SWC nickname1", "SWC nickname2", "SWC nickname3"],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_LENGTH_TWO_ARRAY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_LENGTH_TWO_ARRAY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "TwoArraysLengthMismatch");
    });
    it("Should revert if not exist beneficiaries", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: [],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "EmptyArray");
    });
    it("Should revert if number of beneficiaries > beneficiariesLimit", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const beneficiaries3 = new ethers.Wallet(BENEFICIARIES3_PRIVATE_KEY, provider);

      const legacyId: bigint = BigInt(1);
      const mainConfig: MainConfig = {
        name: "SWC name",
        note: "SWC note",
        nickNames: ["SWC nickname1", "SWC nickname2", "SWC nickname3"],
      };
      const extraConfig: ExtraConfig = {
        lackOfOutgoingTxRange: 200,
      };
      const numBeneficiariesLimit: number = mainConfig.beneficiaries.length - 1;

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyConfig(protocolKit1, signer1.address, legacyId, mainConfig, extraConfig);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      await setBeneficiariesLimit(BigInt(numBeneficiariesLimit));
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "BeneficiaryLimitExceeded");
    });
  });

  describe("setLegacyBeneficiaries", function () {
    it("Should update legacy beneficiaries successfully", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = ["SB nickname 1", "SB nickname 2"];
      const beneficiaries: string[] = [beneficiaries1.address, beneficiaries2.address];
      const minRequiredSignatures: bigint = BigInt(3);
      const legacyAddress: string = await TransferWiLegacyuter.legacyAddresses(legacyId);
      const legacy: TransferWiLegacy await getTransferWiLegacyillAddress);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //State Expect
      const timestampExpect = 1;

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //State After Execute
      const beneficiaries_: string[] = await legacy.getBeneficiaries();

      //Expect
      expect(beneficiaries_).to.deep.equal(beneficiaries);
      expect(tx)
        .to.emit(TransferLegacyRouter, "TransferLegacyBeneficiesUpdated")
        .withArgs(legacyId, nicknames, beneficiaries, minRequiredSignatures, timestampExpect);
    });
    it("Should revert if guard of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = ["SB nickname1", "SB nickname2"];
      const beneficiaries: string[] = [beneficiaries1.address, beneficiaries2.address];
      const minRequiredSignatures: bigint = BigInt(3);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute

      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "GuardSafeWalletInvalid");
    });
    it("Should revert if module of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = ["SB nickname1", "SB nickname2"];
      const beneficiaries: string[] = [beneficiaries1.address, beneficiaries2.address];
      const minRequiredSignatures: bigint = BigInt(3);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute

      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "ModuleSafeWalletInvalid");
    });
    it("Should revert if length of beneficiaries list difference length of nicknames list", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = ["SB nickname 1", "SB nickname 2", "SB nickname3"];
      const beneficiaries: string[] = [beneficiaries1.address, beneficiaries2.address];
      const minRequiredSignatures: bigint = BigInt(3);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "TwoArraysLengthMismatch");
    });

    it("Should revert if not existed beneficiaries", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = [];
      const beneficiaries: string[] = [];
      const minRequiredSignatures: bigint = BigInt(3);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "EmptyArray");
    });
    it("Should revert if number of beneficiaries > beneficiariesLimit", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();

      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const beneficiaries2 = new ethers.Wallet(BENEFICIARIES2_PRIVATE_KEY, provider);
      const beneficiaries3 = new ethers.Wallet(BENEFICIARIES3_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const nicknames: string[] = ["SB nickname1", "SB nickname2", "SB nickname3"];
      const beneficiaries: string[] = [beneficiaries1.address, beneficiaries2.address, beneficiaries3.address];
      const minRequiredSignatures: bigint = BigInt(3);
      const numBeneficiariesLimit: number = beneficiaries.length - 1;

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const safeTransactionHash: string = await setLegacyBeneficiaries(
        protocolKit1,
        signer1.address,
        legacyId,
        nicknames,
        beneficiaries,
        minRequiredSignatures
      );
      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      await setBeneficiariesLimit(BigInt(numBeneficiariesLimit));
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "BeneficiaryLimitExceeded");
    });
  });
  describe("setActivationTrigger", function () {
    it("Should update legacy activation trigger", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const lackOfOutgoingTxRange: bigint = BigInt(60);
      const legacyAddress: string = await TransferLegacyRouter.legacyAddresses(legacyId);
      const legacy: TransferLegacy = await getTransferLegacy(legacyAddress);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setActivationTrigger(protocolKit1, signer1.address, legacyId, lackOfOutgoingTxRange);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //State Expect
      const timestampExpect = 1;

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //State After Execute

      const activationTrigger_: bigint = await legacy.getActivationTrigger();

      //Expect
      expect(activationTrigger_).to.equal(lackOfOutgoingTxRange);
      expect(tx).to.emit(TransferLegacyRouter, "MultisigLegacyCreated").withArgs(legacyId, lackOfOutgoingTxRange, timestampExpect);
    });
    it("Should revert if guard of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const lackOfOutgoingTxRange: bigint = BigInt(60);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setActivationTrigger(protocolKit1, signer1.address, legacyId, lackOfOutgoingTxRange);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "GuardSafeWalletInvalid");
    });
    it("Should revert if module of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const lackOfOutgoingTxRange: bigint = BigInt(60);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setActivationTrigger(protocolKit1, signer1.address, legacyId, lackOfOutgoingTxRange);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "ModuleSafeWalletInvalid");
    });
  });

  describe("setNameNote", function () {
    it("Should update legacy name note", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const name: string = "SNN name";
      const note: string = "SNN note";

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setNameNote(protocolKit1, signer1.address, legacyId, name, note);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //State expect
      const timestamp = 1;

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      await expect(tx).to.emit(TransferLegacyRouter, "TransferLegacyNameNoteUpdated").withArgs(legacyId, name, note, timestamp);
    });

    it("Should revert if guard of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const name: string = "SNN name";
      const note: string = "SNN note";

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setNameNote(protocolKit1, signer1.address, legacyId, name, note);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_GUARD_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      await expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "GuardSafeWalletInvalid");
    });
    it("Should revert if module of safewallet is invalid", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const legacyId: bigint = BigInt(1);
      const name: string = "SNN name";
      const note: string = "SNN note";

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setNameNote(protocolKit1, signer1.address, legacyId, name, note);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_MODULE_INVALID, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      const tx: TransactionResult = await executeTransaction(protocolKit2, safeTransactionHash);

      //Expect
      await expect(tx).to.be.revertedWithCustomError(TransferLegacyRouter, "ModuleSafeWalletInvalid");
    });
  });

  describe("activeLegacy", function () {
    it("Should active legacy", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const legacyAddress: string = await TransferWiLegacyuter.legacyAddresses(legacyId);
      const legacy = await getTransferWiLegacyillAddress);
      const beneficiaries: string[] = await legacy.getBeneficiaries();
      const protocolKit: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, beneficiaries1.address);
      const owners: string[] = await protocolKit.getOwners();

      //State Expect
      const isActiveExpect: bigint = BigInt(2);
      const beneficiariesExpect: string[] = [];
      const ownersExpect: string[] = [...beneficiaries, ...owners];

      //Execute
      const tx = await activeLegacy(legacyId, beneficiaries1);

      //State After Execute
      const legacyInfo_: [bigint, string, bigint] = await legacy.getLegacyLegacy();
      const beneficiaries_: string[] = await legacy.getBeneficiaries();
      const threshold_: number = await protocolKit.getThreshold();
      const owners_: string[] = await protocolKit.getOwners();

      //Expect
      expect(legacyInfo_[2]).to.equal(isActiveExpect);
      expect(beneficiaries_).to.equal(beneficiariesExpect);

      expect(owners_).to.equal(ownersExpect);
    });
    it("Should revert if signer not contain beneficiaries", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const signer = new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const legacyAddress: string = await TransferWiLegacyuter.legacyAddresses(legacyId);
      const legacy = await getTransferWiLegacyillAddress);

      //Execute
      const tx = await activeLegacy(legacyId, signer);

      //Expect
      expect(tx).to.be.revertedWithCustomError(legacy, "NotBeneficiary");
    });
    it("Should revert if not time active legacy", async function () {
      const TransferLegacyRouter: TransferLegacyRouter = await getTransferLegacyRouter();
      //Input
      const beneficiaries1 = new ethers.Wallet(BENEFICIARIES1_PRIVATE_KEY, provider);
      const legacyId: bigint = BigInt(1);
      const lackOfOutgoingTxRange: bigint = BigInt(10 ** 9);
      const legacyAddress: string = await TransferWiLegacyuter.legacyAddresses(legacyId);
      const legacy = await getTransferWiLegacyillAddress);

      const protocolKit1: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER1_PRIVATE_KEY);
      const signer1 = await new ethers.Wallet(SIGNER1_PRIVATE_KEY, provider);

      const safeTransactionHash: string = await setActivationTrigger(protocolKit1, signer1.address, legacyId, lackOfOutgoingTxRange);

      const protocolKit2: Safe = await getProtocolKit(SAFEWALLET_SUCEESFULLY, SIGNER2_PRIVATE_KEY);
      signTransaction(protocolKit2, safeTransactionHash);

      //Execute
      await executeTransaction(protocolKit2, safeTransactionHash);
      const tx = await activeLegacy(legacyId, beneficiaries1);

      //Expect
      expect(tx).to.be.revertedWithCustomError(legacy, "NotEnoughContitionalActive");
    });
  });
});
