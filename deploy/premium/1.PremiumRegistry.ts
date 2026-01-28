import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts, sleep } from "../../scripts/utils";
import contract from '../../contract-addresses.json';
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);

  const usdt = "0x02f62735EaF5fFB56B629bC529e72801713f27cd";
  const usdc = "0xC1Fa197B73577868516dDA2492d44568D9Ec884c";
  const usdtUsdPriceFeed = "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E";
  const usdcUsdPriceFeed = "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E";
  const ethUsdPriceFeed = "0x694AA1769357215DE4FAC081bf1f309aDC325306"; 
  const contracts = getContracts();
  const setting = contracts[network.name]["PremiumSetting"].address;
  const payment = contracts[network.name]["Payment"].address;


  const data = await deploy("PremiumRegistry", {
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
        args: [
          usdt,
          usdc,
          usdtUsdPriceFeed,
          usdcUsdPriceFeed,
          ethUsdPriceFeed,
          setting,
          payment
        ],
      },
    }
  });



  console.log("PremiumRegistry deployed to:", data.address);
  await saveContract(network.name, "DefaultProxyAdmin", data.args![1]);
  await saveContract(network.name, "PremiumRegistry", data.address, data.implementation!);

  // verify proxy contract
  try {
    // verify
    await hre.run("verify:verify", {
      address: data.address,
      constructorArguments: [
         usdt,
          usdc,
          usdtUsdPriceFeed,
          usdcUsdPriceFeed,
          ethUsdPriceFeed,
          setting
      ],
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

deploy.tags = ["PremiumRegistry"];
export default deploy;
