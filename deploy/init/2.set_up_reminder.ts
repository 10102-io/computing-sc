
import Web3 from "web3";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import { saveContract, getContracts, sleep } from "../../scripts/utils";
import { error } from "console";
import { network } from "hardhat";




//Premium
const contracts = getContracts();
const premiumSetting = contracts[network.name]["PremiumSetting"].address;
const registry = contracts[network.name]["PremiumRegistry"].address;
const verifier = contracts[network.name]["EIP712LegacyVerifier"].address;
const multisigLegacyRouter = contracts[network.name]["MultisigLegacyRouter"].address;
const transferLegacyRouter = contracts[network.name]["TransferLegacyRouter"].address;
const transferEOALegacyRouter = contracts[network.name]["TransferEOALegacyRouter"].address;



//Reminder
const manager = contracts[network.name]["PremiumAutomationManager"].address;
const sendMailRouter =contracts[network.name]["PremiumMailRouter"].address;
const mailBeforeActivation = contracts[network.name]["PremiumMailBeforeActivation"].address;
const mailActivated = contracts[network.name]["PremiumMailActivated"].address;
const mailReadyToActivate = contracts[network.name]["PremiumMailReadyToActivate"].address;


//CHAINLINK AUTOMATION
const i_link = "0x779877A7B0D9E8603169DdbD7836e478b4624789"; //Token LINK 
const i_registrar = "0xb0E49c5D0d05cbc241d68c05BC5BA1d1B7B72976";
const keeperRegistry = "0x86EFBD0b6736Bed994962f9797049422A3A8E8Ad";
const baseGasLimit = "1500000";


//CHAINLINK FUNCTION
const router =  "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0"; //fix for sepolia
const subcriptionId = 5168;
const donID = "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000" // fix for sepolia
const gasLimit = "300000";

const web3 = new Web3(process.env.RPC!);

const user_pk = process.env.PK;

const user = web3.eth.accounts.privateKeyToAccount(user_pk!).address;

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

async function setPramramPremiumSetting() {

    console.log('setPramramPremiumSetting...');
    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(Setting);

    const txData = contract.methods
        .setParams(registry, transferLegacyRouter, transferEOALegacyRouter, multisigLegacyRouter ).encodeABI();

    //using ETH
    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(1000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: premiumSetting,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, user_pk!);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);
}


async function setUpReminder() {

    console.log('setUpReminder... at PremiumSetting');
    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(Setting);

    const txData = contract.methods
        .setUpReminder(manager, sendMailRouter).encodeABI();

    //using ETH
    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(1000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: premiumSetting,
        from: user,
    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, user_pk!);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);
}

async function setParamsManager () {
    console.log('Set up Manager Params...');
    const txCount = await web3.eth.getTransactionCount(user);
    const contract = new web3.eth.Contract(Manager, manager);

    const txData = await contract.methods.
    setParams(i_link, i_registrar, keeperRegistry, premiumSetting, baseGasLimit,sendMailRouter, 150 ).encodeABI();
    console.log(txData)
    //using ETH
    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(4000000),
        gasPrice: await web3.eth.getGasPrice(),
        data: txData,
        to: manager,
        from: user,
    };

     const signedTx = await web3.eth.accounts.signTransaction(txObj, user_pk!);

    const result = await web3.eth.sendSignedTransaction(signedTx.rawTransaction!);
    console.log(result);

}  

async function setParamsMailRouter() {
    console.log('Setting params at PremiumMailRouter');

    const txCount = await web3.eth.getTransactionCount(user);

    const contract = new web3.eth.Contract(PremiumMailRouter, sendMailRouter);

    const txData = contract.methods
        .setParams(mailBeforeActivation, mailActivated, mailReadyToActivate, premiumSetting, manager)
        .encodeABI();
    console.log(txData);

    //using ETH
    const calculateFeeData = await web3.eth.calculateFeeData()
    const txObj = {
        nonce: txCount,
        gas: web3.utils.toHex(4000000),
        gasPrice: (await web3.eth.getGasPrice()).toString(),
        data: txData,
        to: sendMailRouter,
        from: user,

    };

    const signedTx = await web3.eth.accounts.signTransaction(txObj, user_pk!);

    const result = await web3.eth.sendSignedTransaction(
        signedTx.rawTransaction!
    );
    console.log(result);
   
    
    
}




async function main () {
    // Setting contract
    // await setPramramPremiumSetting();
    // await setUpReminder();

    // When set up / replace Automation Manager, 
    // run these following functions to set up the reminder system
    // await setParamsManager();
    
    //  Send Mail
    await setParamsMailRouter();

}
main().catch((error) => {
    console.log(error);
    process.exitCode = 1;
})