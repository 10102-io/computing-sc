import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts, getRpcUrl, verifyProxyOnEtherscan, shouldVerify, getExternalAddresses } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);
  const contracts = await getContracts();
  const legacyDeployer = contracts[network.name].LegacyDeployer.address;
  const setting = contracts[network.name].PremiumSetting.address;
  const verifierTerm = contracts[network.name].EIP712LegacyVerifier.address;
  const payment = contracts[network.name].Payment.address;
  const { uniswapRouter, weth } = getExternalAddresses(network.name);

  const data = await deploy("TransferEOALegacyRouter", {
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
        args: [legacyDeployer, setting, verifierTerm, payment, uniswapRouter, weth],
      },
    },
  });



  console.log("TransferEOALegacyRouter deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "TransferEOALegacyRouter", data.address, data.implementation!);

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

deploy.tags = ["TransferEOALegacyRouter"];
deploy.dependencies = ["LegacyDeployer", "PremiumSetting", "EIP712LegacyVerifier", "Payment"];
export default deploy;
