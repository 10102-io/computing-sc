import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract } from "../../scripts/utils";
import * as dotenv from "dotenv";
dotenv.config();
import Web3 from "web3";

const TOKENS: { name: string; symbol: string; decimals: number }[] = [
  { name: "USD Coin", symbol: "USDC", decimals: 6 },
  { name: "Tether USD", symbol: "USDT", decimals: 6 },
  { name: "LABRYS", symbol: "LABRYS", decimals: 18 },
];

const MINT_AMOUNT = 1000; // 1000 tokens each (raw amount = MINT_AMOUNT * 10**decimals)

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const web3 = new Web3(process.env.RPC!);
  const gasPrice = (await web3.eth.getGasPrice()).toString();

  for (const { name, symbol, decimals } of TOKENS) {
    const data = await deploy("ERC20Token", {
      from: deployer,
      args: [name, symbol, decimals],
      log: true,
      deterministicDeployment: false,
      gasPrice,
    });

    const contractName = `ERC20Token_${symbol}`;
    console.log(`${symbol} deployed to:`, data.address);
    await saveContract(network.name, contractName, data.address);

    const amount = BigInt(MINT_AMOUNT) * BigInt(10) ** BigInt(decimals);
    const token = await hre.ethers.getContractAt("ERC20Token", data.address);
    const tx = await token.mint(deployer, amount);
    await tx.wait();
    console.log(`Minted ${MINT_AMOUNT} ${symbol} to deployer`);

    try {
      await hre.run("verify:verify", {
        address: data.address,
        constructorArguments: [name, symbol, decimals],
      });
    } catch (e) {
      console.log(e);
    }
  }
};

deploy.tags = ["TestERC20Tokens"];
export default deploy;
