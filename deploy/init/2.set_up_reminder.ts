import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getExternalAddresses } from "../../scripts/utils";

const ZERO = "0x0000000000000000000000000000000000000000";

const setUpReminder: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, ethers, network } = hre;

  const premiumSettingDeploy = await deployments.get("PremiumSetting");
  const managerDeploy = await deployments.get("PremiumAutomationManager");
  const mailRouterDeploy = await deployments.get("PremiumMailRouter");
  const mailBeforeDeploy = await deployments.get("PremiumMailBeforeActivation");
  const mailActivatedDeploy = await deployments.get("PremiumMailActivated");
  const mailReadyDeploy = await deployments.get("PremiumMailReadyToActivate");

  // 1. PremiumSetting.setUpReminder(manager, sendMailRouter)
  console.log("Calling setUpReminder on PremiumSetting...");
  const premiumSetting = await ethers.getContractAt("PremiumSetting", premiumSettingDeploy.address);
  const tx1 = await premiumSetting.setUpReminder(managerDeploy.address, mailRouterDeploy.address);
  await tx1.wait();
  console.log("setUpReminder done, tx:", tx1.hash);

  // 2. PremiumAutomationManager.setParams — requires real Chainlink on-chain.
  //    Skipped on local/hardhat networks where Chainlink contracts don't exist.
  const isLocalNetwork = ["hardhat", "localhost"].includes(network.name);
  const externalAddrs = getExternalAddresses(network.name);
  const chainlinkLink = externalAddrs.chainlinkLink;

  if (!isLocalNetwork && chainlinkLink !== ZERO) {
    console.log("Calling setParams on PremiumAutomationManager...");
    const manager = await ethers.getContractAt("PremiumAutomationManager", managerDeploy.address);
    const tx2 = await manager.setParams(
      chainlinkLink,
      externalAddrs.chainlinkRegistrar,
      externalAddrs.chainlinkKeeperRegistry,
      premiumSettingDeploy.address,
      externalAddrs.chainlinkBaseGasLimit,
      mailRouterDeploy.address,
      150
    );
    await tx2.wait();
    console.log("setParams (manager) done, tx:", tx2.hash);
  } else {
    console.log("Skipping setParamsManager — Chainlink not available on this network");
  }

  // 3. PremiumMailRouter.setParams(mailBefore, mailActivated, mailReady, premiumSetting, manager)
  console.log("Calling setParams on PremiumMailRouter...");
  const mailRouter = await ethers.getContractAt("PremiumMailRouter", mailRouterDeploy.address);
  const tx3 = await mailRouter.setParams(
    mailBeforeDeploy.address,
    mailActivatedDeploy.address,
    mailReadyDeploy.address,
    premiumSettingDeploy.address,
    managerDeploy.address
  );
  await tx3.wait();
  console.log("setParams (mail router) done, tx:", tx3.hash);
};

setUpReminder.tags = ["init", "set_up_reminder"];
setUpReminder.dependencies = [
  "PremiumSetting",
  "PremiumAutomationManager",
  "PremiumMailRouter",
  "PremiumMailBeforeActivation",
  "PremiumMailActivated",
  "PremiumMailReadyToActivate",
];
setUpReminder.id = "set_up_reminder";
export default setUpReminder;
