import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);

  const data = await deploy("TokenWhiteList", {
    from: deployer,
    args: [deployer],
    log: true,
    deterministicDeployment: false,
    gasPrice: (await web3.eth.getGasPrice()).toString(),
  });

  console.log("TokenWhiteList deployed to:", data.address);
  await saveContract(network.name, "TokenWhiteList", data.address);

  try {
    await hre.run("verify:verify", {
      address: data.address,
      constructorArguments: [deployer],
    });
  } catch (e) {
    console.log(e);
  }
};

deploy.tags = ["TokenWhiteList"];
export default deploy;
