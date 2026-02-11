import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  saveContract,
  verifyProxyOnEtherscan,
  shouldVerify,
  getBumpedGasPrice,
  sleep,
  getExternalAddresses,
} from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const rpcUrl =
    (network.config as { url?: string })?.url ||
    process.env.RPC ||
    process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) throw new Error("No RPC URL for gas price (set RPC or network url)");
  const web3 = new Web3(rpcUrl);

  if (network.name !== "hardhat" && network.name !== "localhost") {
    await sleep(8000);
  }

  const { verifierTermOwner } = getExternalAddresses(network.name);
  const data = await deploy("EIP712LegacyVerifier", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    gasPrice: await getBumpedGasPrice(web3),
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      execute: {
        methodName: "initialize",
        args: [verifierTermOwner],
      },
    }
  });


  console.log("EIP712LegacyVerifier deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "EIP712LegacyVerifier", data.address, data.implementation!);

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

deploy.tags = ["EIP712LegacyVerifier"];
export default deploy;
