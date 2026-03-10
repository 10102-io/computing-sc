import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, verifyProxyOnEtherscan, shouldVerify } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const router = (await deployments.get("TimeLockRouter")).address;

  const result = await deploy("TimelockERC20", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    skipIfAlreadyDeployed: true,
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [deployer, router], // initialOwner
      },
    }
  });

  console.log("TimelockERC20 deployed to:", result.address);

  await saveContract(network.name, "DefaultProxyAdmin", result.args![1]);
  await saveContract(network.name, "TimelockERC20", result.address, result.implementation!);

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

deploy.tags = ["TimelockERC20"];
deploy.dependencies = ["TimeLockRouter"];
deploy.skip = async (hre: HardhatRuntimeEnvironment) => {
  if (!hre.network.live) return false;
  const existing = await hre.deployments.getOrNull("TimelockERC20");
  return existing != null;
};
export default deploy;
