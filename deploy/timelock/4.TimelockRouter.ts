import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract } from "../../scripts/utils";
import * as dotenv from "dotenv";
import Web3 from "web3";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);

  const result = await deploy("TimeLockRouter", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    gasLimit: 4000000,
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [deployer], // initialOwner
      },
    },
  });

  console.log("TimeLockRouter deployed to:", result.address);

  await saveContract(network.name, "DefaultProxyAdmin", result.args![1]);
  await saveContract(network.name, "TimeLockRouter", result.address, result.implementation!);

  // verify proxy
  try {
    await hre.run("verify:verify", {
      address: result.address,
      constructorArguments: [],
    });
  } catch (err) {
    console.warn("Proxy verify failed:", err);
  }

  // verify implementation
  try {
    await hre.run("verify:verify", {
      address: result.implementation,
      constructorArguments: [],
    });
  } catch (err) {
    console.warn("Implementation verify failed:", err);
  }
};

deploy.tags = ["TimeLockRouter"];
export default deploy;
