import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, shouldVerify } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const data = await deploy("MockPremiumSendMail", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
  });

  console.log("PremiumSendMail deployed to:", data.address);
  await saveContract(network.name, "PremiumSendMail", data.address);

  if (shouldVerify(network.name)) {
    try {
      await hre.run("verify:verify", {
        address: data.address,
        constructorArguments: [],
      });
    } catch (e) {
      console.warn("Verify failed:", e);
    }
  }
};

deploy.tags = ["PremiumSendMail"];
export default deploy;
