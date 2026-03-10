import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import {
  saveContract,
  shouldRunTestERC20,
  getBumpedGasPrice,
  sleep,
} from "../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const DECIMALS = 6;
const MINT_AMOUNT = 100_000 * 10 ** DECIMALS;

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy: deployContract } = deployments;
  const { deployer } = await getNamedAccounts();

  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const baseOptions: Parameters<typeof deployContract>[1] = {
    from: deployer,
    log: true,
    deterministicDeployment: false,
  };
  if (!isLocal && process.env.RPC) {
    const web3 = new Web3(process.env.RPC);
    baseOptions.gasPrice = await getBumpedGasPrice(web3);
  }

  const usdc = await deployContract("ERC20Token_USDC", {
    ...baseOptions,
    contract: "ERC20Token",
    args: ["Test USDC", "USDC", DECIMALS],
  });
  const usdt = await deployContract("ERC20Token_USDT", {
    ...baseOptions,
    contract: "ERC20Token",
    args: ["Test USDT", "USDT", DECIMALS],
  });

  const usdcToken = await ethers.getContractAt("ERC20Token", usdc.address);
  const usdtToken = await ethers.getContractAt("ERC20Token", usdt.address);
  await usdcToken.mint(deployer, MINT_AMOUNT);
  await usdtToken.mint(deployer, MINT_AMOUNT);

  await saveContract(network.name, "ERC20Token_USDC", usdc.address);
  await saveContract(network.name, "ERC20Token_USDT", usdt.address);

  console.log("Test ERC20 USDC deployed to:", usdc.address);
  console.log("Test ERC20 USDT deployed to:", usdt.address);

  if (!isLocal) {
    await sleep(3000);
  }
};

deploy.skip = async (hre: HardhatRuntimeEnvironment): Promise<boolean> => {
  return !shouldRunTestERC20(hre.network.name);
};

deploy.tags = ["TestERC20"];
export default deploy;
