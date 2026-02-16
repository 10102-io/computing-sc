import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  saveContract,
  getContracts,
  shouldVerify,
  shouldRunTestERC20,
} from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const isLocal = !network.live;
  const deployOptions: Parameters<typeof deploy>[1] = {
    from: deployer,
    args: [deployer],
    log: true,
    deterministicDeployment: false,
  };
  if (!isLocal && process.env.RPC) {
    const web3 = new Web3(process.env.RPC);
    deployOptions.gasPrice = (await web3.eth.getGasPrice()).toString();
  }

  const data = await deploy("TokenWhiteList", deployOptions);

  console.log("TokenWhiteList deployed to:", data.address);
  await saveContract(network.name, "TokenWhiteList", data.address);

  const usdcDeploy = await deployments.getOrNull("ERC20Token_USDC");
  const usdtDeploy = await deployments.getOrNull("ERC20Token_USDT");
  const testUsdc =
    usdcDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDC?.address;
  const testUsdt =
    usdtDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDT?.address;
  if (
    shouldRunTestERC20(network.name) &&
    testUsdc != null &&
    testUsdt != null
  ) {
    const whitelist = await ethers.getContractAt("TokenWhiteList", data.address);
    if (!(await whitelist.isWhitelisted(testUsdc))) {
      await whitelist.addToken(testUsdc);
    }
    if (!(await whitelist.isWhitelisted(testUsdt))) {
      await whitelist.addToken(testUsdt);
    }
    console.log("Added test ERC20 USDC and USDT to TokenWhiteList");
  }

  if (shouldVerify(network.name)) {
    try {
      await hre.run("verify:verify", {
        address: data.address,
        constructorArguments: [deployer],
      });
    } catch (e) {
      console.warn("Verify failed:", e);
    }
  }
};

deploy.tags = ["TokenWhiteList"];
deploy.dependencies = ["TestERC20"];
export default deploy;
