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

  const web3 = new Web3(process.env.RPC!);
  const router = "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0"; //fix for sepolia
  const subcriptionId = 5168;
  const donID = "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000" // fix for sepolia
  const gasLimit = "300000";
  const contracts = getContracts();
  const sendMailRouter = contracts[network.name]["PremiumMailRouter"].address;



  const data = await deploy("PremiumMailActivated", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    // gasPrice: (await web3.eth.getGasPrice()).toString() + "0",
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [router, subcriptionId, donID, gasLimit, sendMailRouter],
      },
    },
    // gasLimit: 10000000,
  });

  console.log("PremiumMailActivated deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "PremiumMailActivated", data.address, data.implementation!);

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

deploy.tags = ["PremiumMailActivated"];
export default deploy;
