import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getContracts, saveContract, getRpcUrl, verifyProxyOnEtherscan } from "../../scripts/utils";
import * as dotenv from "dotenv";
import Web3 from "web3";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(getRpcUrl(network.config));

  const contracts = await getContracts();
  const router = contracts[network.name].TimeLockRouter.address;

  const result = await deploy("TimelockERC721", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    gasPrice: (await web3.eth.getGasPrice()).toString(),
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [deployer, router], // initialOwner
      },
    },
  });

  console.log("TimelockERC721 deployed to:", result.address);

  await saveContract(network.name, "DefaultProxyAdmin", result.args![1]);
  await saveContract(network.name, "TimelockERC721", result.address, result.implementation!);

  // Verify implementation only (proxy may use a different compiler)
  try {
    await hre.run("verify:verify", {
      address: result.implementation,
      constructorArguments: [],
    });
  } catch (err) {
    console.warn("Implementation verify failed:", err);
  }

  const apiKey = process.env.API_KEY_ETHERSCAN;
  const chainId = network.config?.chainId;
  if (apiKey && chainId != null && result.address && result.implementation) {
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

deploy.tags = ["TimelockERC721"];
export default deploy;
