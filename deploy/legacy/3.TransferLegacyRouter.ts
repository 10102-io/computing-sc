import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts, sleep, getRpcUrl, verifyProxyOnEtherscan } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const data = await deploy("TransferLegacyRouter", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    // gasLimit: 4000000,
    // gasPrice: (await web3.eth.getGasPrice() * BigInt(50)).toString(),
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      // execute: {
      //   methodName: "initialize",
      //   args: [legacyDeployer, setting, verifierTerm, payment, router, weth],
      // },
    }
  });



  console.log("TransferLegacyRouter deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "TransferLegacyRouter", data.address, data.implementation!);

  // Verify implementation only (proxy may use a different compiler)
  try {
    await hre.run("verify:verify", {
      address: data.implementation,
      constructorArguments: [],
    });
  } catch (e) {
    console.log(e);
  }

  const apiKey = process.env.API_KEY_ETHERSCAN;
  const chainId = network.config?.chainId;
  if (apiKey && chainId != null && data.address && data.implementation) {
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
export default deploy;
