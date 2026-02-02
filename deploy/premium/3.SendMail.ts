import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts, sleep } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);

  const data = await deploy("PremiumSendMail", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    // gasPrice: (await web3.eth.getGasPrice()).toString() + "0",
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
        // execute: {
        //   methodName: "initialize",
        //   args: [],
        // },
    },
    // gasLimit: 10000000,
  });

  console.log("PremiumSendMail deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "PremiumSendMail", data.address, data.implementation!);

  //verify proxy contract
  try {
    // verify
    await hre.run("verify:verify", {
      address: data.address,
      constructorArguments: [],
    });
  } catch (e) {
    console.log(e);
  }

  // verify impl contract
  try {
    // verify
    await hre.run("verify:verify", {
      address: data.implementation,
      constructorArguments: [],
    });
  } catch (e) {
    console.log(e);
  }
};

deploy.tags = ["PremiumSendMail"];
export default deploy;
