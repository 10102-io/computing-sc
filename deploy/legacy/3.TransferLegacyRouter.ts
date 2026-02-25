import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getRpcUrl, verifyProxyOnEtherscan, shouldVerify, getExternalAddresses } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const legacyDeployer = (await deployments.get("LegacyDeployer")).address;
  const premiumSetting = (await deployments.get("PremiumSetting")).address;
  const verifier = (await deployments.get("EIP712LegacyVerifier")).address;
  const payment = (await deployments.get("Payment")).address;
  const externalAddrs = getExternalAddresses(network.name);
  const { uniswapRouter, weth } = externalAddrs;

  const data = await deploy("TransferLegacyRouter", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [legacyDeployer, premiumSetting, verifier, payment, uniswapRouter, weth],
      },
    },
  });



  console.log("TransferLegacyRouter deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "TransferLegacyRouter", data.address, data.implementation!);

  if (shouldVerify(network.name)) {
    try {
      await hre.run("verify:verify", {
        address: data.implementation,
        constructorArguments: [],
      });
    } catch (e) {
      console.warn("Verify failed:", e);
    }
  }

  const apiKey = process.env.API_KEY_ETHERSCAN;
  const chainId = network.config?.chainId;
  if (shouldVerify(network.name) && apiKey && chainId != null && data.address && data.implementation) {
    try {
      const result = await verifyProxyOnEtherscan(
        data.address,
        data.implementation,
        chainId,
        apiKey
      );
      if (result.success) {
        console.log("Etherscan proxy link:", result.message);
      } else {
        console.warn("Etherscan proxy verification:", result.message);
      }
    } catch (e) {
      console.warn("Etherscan proxy verification failed:", e);
    }
  }
};

deploy.tags = ["TransferLegacyRouter"];
deploy.dependencies = ["LegacyDeployer", "PremiumSetting", "EIP712LegacyVerifier", "Payment"];
export default deploy;
