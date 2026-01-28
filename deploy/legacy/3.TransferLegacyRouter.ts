import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts, sleep } from "../../scripts/utils";
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
  const payment =  contracts[network.name].Payment.address;
  const router = "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008";
  const weth = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9";


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

  // verify proxy contract
  try {
    // verify
    await hre.run("verify:verify", {
      address: data.address,
      constructorArguments: [],
    });
  } catch (e) {
    console.log(e);
  }

  // verify impl contract
  try {
    // verify
    await hre.run("verify:verify", {
      address: data.implementation,
      constructorArguments: [],
    });
  } catch (e) {
    console.log(e);
  }
};

deploy.tags = ["TransferLegacyRouter"];
export default deploy;
