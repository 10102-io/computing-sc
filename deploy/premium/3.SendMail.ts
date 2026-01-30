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

  const web3 = new Web3(getRpcUrl(network.config));

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

deploy.tags = ["PremiumSendMail"];
export default deploy;
