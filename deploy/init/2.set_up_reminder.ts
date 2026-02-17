import * as dotenv from "dotenv";
import { DeployFunction } from "hardhat-deploy/dist/types";
import Web3 from "web3";
dotenv.config();

import * as fs from "fs";
import { network } from "hardhat";
import { getContracts, getExternalAddresses } from "../../scripts/utils";

function getWeb3(): Web3 {
    const rpc = process.env.RPC;
    if (!rpc) throw new Error("Set RPC in .env");
    return new Web3(rpc);
}

function getUserAddress(): string {
    const userPk = process.env.PK;
    if (!userPk) throw new Error("Set PK in .env");
    return getWeb3().eth.accounts.privateKeyToAccount(userPk).address;
}

const Manager = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumAutomationManager.sol/PremiumAutomationManager.json",
        "utf-8"
    )
).abi;



const PremiumMailRouter = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumMailRouter.sol/PremiumMailRouter.json",
        "utf-8"
    )
).abi;

const Setting = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumSetting.sol/PremiumSetting.json",
        "utf-8"
    )
).abi;

async function setPramramPremiumSetting(
    web3: Web3,
    user: string,
    userPk: string,
    premiumSetting: string,
    registry: string,
    transferLegacyRouter: string,
    transferEOALegacyRouter: string,
    multisigLegacyRouter: string
) {
    console.log('setPramramPremiumSetting...');
    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(Setting);

    const txData = contract.methods
        .setParams(registry, transferLegacyRouter, transferEOALegacyRouter, multisigLegacyRouter).encodeABI();

    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(1000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: premiumSetting,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, userPk);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);
}


async function setUpReminder(
    web3: Web3,
    user: string,
    userPk: string,
    premiumSetting: string,
    manager: string,
    sendMailRouter: string
) {
    console.log('setUpReminder... at PremiumSetting');
    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(Setting);

    const txData = contract.methods
        .setUpReminder(manager, sendMailRouter).encodeABI();

    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(1000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: premiumSetting,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, userPk);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);
}

async function setParamsManager(
    web3: Web3,
    user: string,
    userPk: string,
    manager: string,
    premiumSetting: string,
    sendMailRouter: string,
    chainlink: { link: string; registrar: string; keeperRegistry: string; baseGasLimit: string }
) {
    console.log('Set up Manager Params...');
    const txCount = await web3.eth.getTransactionCount(user);
    const contract = new web3.eth.Contract(Manager, manager);

    const txData = await contract.methods
        .setParams(chainlink.link, chainlink.registrar, chainlink.keeperRegistry, premiumSetting, chainlink.baseGasLimit, sendMailRouter, 150).encodeABI();
    console.log(txData);
    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(4000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: manager,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, userPk);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);

}

async function setParamsMailRouter(
    web3: Web3,
    user: string,
    userPk: string,
    sendMailRouter: string,
    mailBeforeActivation: string,
    mailActivated: string,
    mailReadyToActivate: string,
    premiumSetting: string,
    manager: string
) {
    console.log('Setting params at PremiumMailRouter');

    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(PremiumMailRouter, sendMailRouter);

    const txData = contract.methods
        .setParams(mailBeforeActivation, mailActivated, mailReadyToActivate, premiumSetting, manager)
        .encodeABI();
    console.log(txData);

    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(4000000),
        gasPrice: (await web3.eth.getGasPrice()).toString(),
        data: txData,
        to: sendMailRouter,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, userPk);

    const result = await web3.eth.sendSignedTransaction(
        signedTx.rawTransaction!
    );
    console.log(result);



}




async function main() {
    const contracts = getContracts();
    const networkContracts = contracts[network.name];
    if (!networkContracts) {
        throw new Error(`No contract addresses found for network: ${network.name}. Deploy contracts first.`);
    }
    const premiumSetting = networkContracts["PremiumSetting"].address;
    const registry = networkContracts["PremiumRegistry"].address;
    const multisigLegacyRouter = networkContracts["MultisigLegacyRouter"].address;
    const transferLegacyRouter = networkContracts["TransferLegacyRouter"].address;
    const transferEOALegacyRouter = networkContracts["TransferEOALegacyRouter"].address;
    const manager = networkContracts["PremiumAutomationManager"].address;
    const sendMailRouter = networkContracts["PremiumMailRouter"].address;
    const mailBeforeActivation = networkContracts["PremiumMailBeforeActivation"].address;
    const mailActivated = networkContracts["PremiumMailActivated"].address;
    const mailReadyToActivate = networkContracts["PremiumMailReadyToActivate"].address;

    const web3 = getWeb3();
    const user = getUserAddress();
    const userPk = process.env.PK!;

    // Setting contract
    const externalAddrs = getExternalAddresses(network.name);
    const chainlink = {
        link: externalAddrs.chainlinkLink,
        registrar: externalAddrs.chainlinkRegistrar,
        keeperRegistry: externalAddrs.chainlinkKeeperRegistry,
        baseGasLimit: externalAddrs.chainlinkBaseGasLimit,
    };

    // await setPramramPremiumSetting(web3, user, userPk, premiumSetting, registry, transferLegacyRouter, transferEOALegacyRouter, multisigLegacyRouter);
    // await setUpReminder(web3, user, userPk, premiumSetting, manager, sendMailRouter);
    // await setParamsManager(web3, user, userPk, manager, premiumSetting, sendMailRouter, chainlink);

    await setParamsMailRouter(web3, user, userPk, sendMailRouter, mailBeforeActivation, mailActivated, mailReadyToActivate, premiumSetting, manager);
}
if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

const deployFunc: DeployFunction = async () => {
    /* Run via: npx hardhat run deploy/init/2.set_up_reminder.ts --network <network> */
};
deployFunc.tags = ["init", "set_up_reminder"];
deployFunc.id = "set_up_reminder";
export default deployFunc;