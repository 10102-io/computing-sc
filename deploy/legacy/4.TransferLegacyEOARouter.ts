import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, verifyProxyOnEtherscan, shouldVerify, getExternalAddresses } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const legacyDeployer = (await deployments.get("LegacyDeployer")).address;
  const setting = (await deployments.get("PremiumSetting")).address;
  const verifierTerm = (await deployments.get("EIP712LegacyVerifier")).address;
  const payment = (await deployments.get("Payment")).address;
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
        init: {
          methodName: "initialize",
          args: [legacyDeployer, setting, verifierTerm, payment, uniswapRouter, weth],
        },
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
// NOTE: Dependencies intentionally omitted to prevent this tag from triggering
// unrelated proxy upgrades (e.g. PremiumSetting) on networks where other
// contracts have drifted bytecode since their last deploy. Fresh-network
// deploys should instead use `hardhat deploy` without tags (which runs every
// script in order) so dependencies are satisfied.
export default deploy;
