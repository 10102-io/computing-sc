import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();

/**
 * No separate PremiumSendMail contract exists; PremiumMailRouter is the send-mail entry point
 * and implements the IPremiumSendMail interface. This script records PremiumMailRouter's
 * address under the "PremiumSendMail" key for compatibility.
 */
const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network } = hre;
  const { get } = deployments;

  const router = await get("PremiumMailRouter");
  await saveContract(network.name, "PremiumSendMail", router.address);
  console.log("PremiumSendMail (PremiumMailRouter) recorded at:", router.address);
};

deploy.tags = ["PremiumSendMail"];
deploy.dependencies = ["PremiumMailRouter"];
export default deploy;
