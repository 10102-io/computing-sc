import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, sleep, getRpcUrl, verifyProxyOnEtherscan } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);
  const legacyDeployer = (await get("LegacyDeployer")).address;
  const setting = (await get("PremiumSetting")).address;
  const verifierTerm = (await get("EIP712LegacyVerifier")).address;
  const payment = (await get("Payment")).address;
  const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
  const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";


  const data = await deploy("TransferEOALegacyRouter", {
    from: deployer,
    args: [],
    log: true,
    deterministicDeployment: false,
    gasLimit: 4000000,
    // gasPrice: (await web3.eth.getGasPrice()).toString(),
    proxy: {
      proxyContract: "OptimizedTransparentProxy",
      owner: deployer,
      // execute: {
      //   methodName: "initialize",
      //   args: [legacyDeployer, setting, verifierTerm, payment, router, weth],
      // },
    }
  });



  console.log("TransferEOALegacyRouter deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "TransferEOALegacyRouter", data.address, data.implementation!);

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

deploy.tags = ["TransferEOALegacyRouter"];
deploy.dependencies = ["LegacyDeployer", "PremiumSetting", "EIP712LegacyVerifier", "Payment"];
export default deploy;
