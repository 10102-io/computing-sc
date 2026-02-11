import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, shouldVerify, getBumpedGasPrice } from "../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const deployOptions: Parameters<typeof deploy>[1] = {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
  };
  if (!isLocal && process.env.RPC) {
    const web3 = new Web3(process.env.RPC);
    deployOptions.gasPrice = await getBumpedGasPrice(web3);
  }

  const data = await deploy("Payment", deployOptions);


  console.log("Payment deployed to:", data.address);
  await saveContract(network.name, "Payment", data.address, data.implementation!);

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

deploy.tags = ["Payment"];
export default deploy;
