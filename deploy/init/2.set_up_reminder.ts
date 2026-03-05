import { DeployFunction } from "hardhat-deploy/dist/types";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

import * as fs from "fs";
import { network } from "hardhat";
import { getContracts, getExternalAddresses, getProvider } from "../../scripts/utils";

const ManagerAbi = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumAutomationManager.sol/PremiumAutomationManager.json",
        "utf-8"
    )
).abi;

const PremiumMailRouterAbi = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumMailRouter.sol/PremiumMailRouter.json",
        "utf-8"
    )
).abi;

const SettingAbi = JSON.parse(
    fs.readFileSync(
        "./artifacts/contracts/premium/PremiumSetting.sol/PremiumSetting.json",
        "utf-8"
    )
).abi;

async function setUpReminder(
    premiumSetting: string,
    manager: string,
    sendMailRouter: string
) {
    console.log("Calling setUpReminder at PremiumSetting...");
    const { wallet } = getProvider();
    const contract = new ethers.Contract(premiumSetting, SettingAbi, wallet);
    const tx = await contract.setUpReminder(manager, sendMailRouter);
    const receipt = await tx.wait();
    console.log("setUpReminder done, tx:", receipt.transactionHash);
}

async function setParamsManager(
    manager: string,
    premiumSetting: string,
    sendMailRouter: string,
    chainlink: { link: string; registrar: string; keeperRegistry: string; baseGasLimit: string }
) {
    console.log("Calling setParams at PremiumAutomationManager...");
    const { wallet } = getProvider();
    const contract = new ethers.Contract(manager, ManagerAbi, wallet);
    const tx = await contract.setParams(
        chainlink.link,
        chainlink.registrar,
        chainlink.keeperRegistry,
        premiumSetting,
        chainlink.baseGasLimit,
        sendMailRouter,
        150
    );
    const receipt = await tx.wait();
    console.log("setParamsManager done, tx:", receipt.transactionHash);
}

async function setParamsMailRouter(
    sendMailRouter: string,
    mailBeforeActivation: string,
    mailActivated: string,
    mailReadyToActivate: string,
    premiumSetting: string,
    manager: string
) {
    console.log("Calling setParams at PremiumMailRouter...");
    const { wallet } = getProvider();
    const contract = new ethers.Contract(sendMailRouter, PremiumMailRouterAbi, wallet);
    const tx = await contract.setParams(
        mailBeforeActivation,
        mailActivated,
        mailReadyToActivate,
        premiumSetting,
        manager
    );
    const receipt = await tx.wait();
    console.log("setParamsMailRouter done, tx:", receipt.transactionHash);
}

async function main() {
    const contracts = getContracts();
    const networkContracts = contracts[network.name];
    if (!networkContracts) {
        throw new Error(`No contract addresses found for network: ${network.name}. Deploy contracts first.`);
    }
    const premiumSetting = networkContracts["PremiumSetting"].address;
    const manager = networkContracts["PremiumAutomationManager"].address;
    const sendMailRouter = networkContracts["PremiumMailRouter"].address;
    const mailBeforeActivation = networkContracts["PremiumMailBeforeActivation"].address;
    const mailActivated = networkContracts["PremiumMailActivated"].address;
    const mailReadyToActivate = networkContracts["PremiumMailReadyToActivate"].address;

    const externalAddrs = getExternalAddresses(network.name);
    const chainlink = {
        link: externalAddrs.chainlinkLink,
        registrar: externalAddrs.chainlinkRegistrar,
        keeperRegistry: externalAddrs.chainlinkKeeperRegistry,
        baseGasLimit: externalAddrs.chainlinkBaseGasLimit,
    };

    // await setUpReminder(premiumSetting, manager, sendMailRouter);
    // await setParamsManager(manager, premiumSetting, sendMailRouter, chainlink);

    await setParamsMailRouter(sendMailRouter, mailBeforeActivation, mailActivated, mailReadyToActivate, premiumSetting, manager);
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
