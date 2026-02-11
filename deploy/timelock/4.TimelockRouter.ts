import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getRpcUrl, verifyProxyOnEtherscan, shouldVerify } from "../../scripts/utils";
import * as dotenv from "dotenv";
import Web3 from "web3";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

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

  if (shouldVerify(network.name)) {
    try {
      await hre.run("verify:verify", {
        address: result.implementation,
        constructorArguments: [],
      });
    } catch (err) {
      console.warn("Implementation verify failed:", err);
    }
  }

  const apiKey = process.env.API_KEY_ETHERSCAN;
  const chainId = network.config?.chainId;
  if (shouldVerify(network.name) && apiKey && chainId != null && result.address && result.implementation) {
    try {
      const verifyResult = await verifyProxyOnEtherscan(
        result.address,
        result.implementation,
        chainId,
        apiKey
      );
      if (verifyResult.success) {
        console.log("Etherscan proxy link:", verifyResult.message);
      } else {
        console.warn("Etherscan proxy verification:", verifyResult.message);
      }
    } catch (e) {
      console.warn("Etherscan proxy verification failed:", e);
    }
  }
};

deploy.tags = ["TimeLockRouter"];
deploy.dependencies = ["TimelockERC20", "TimelockERC721", "TimelockERC1155"];
export default deploy;
