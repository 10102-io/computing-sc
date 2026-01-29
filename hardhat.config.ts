import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "hardhat-contract-sizer";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: {
      default: 0,
    },
    dev: {
      // Default to 1
      default: 1,
      // dev address mainnet
      // 1: "",
    },
  },
  networks: {
    // hardhat: {
    //   chainId: 1337,

    // },
    hardhat: {
      forking: {
        url: process.env.RPC as string,
        blockNumber: 10145739,
      },
    },

    sepolia: {
      url: "https://eth-sepolia.public.blastapi.io",
      chainId: 11155111,
      gasPrice: "auto",
      accounts: process.env.DEPLOYER_PRIVATE_KEY !== undefined ? [process.env.DEPLOYER_PRIVATE_KEY as string] : [],
    },
    mainnet: {
      url: "https://ethereum-rpc.publicnode.com",
      chainId: 1,
      gasPrice: "auto",
      accounts: process.env.DEPLOYER_PRIVATE_KEY !== undefined ? [process.env.DEPLOYER_PRIVATE_KEY as string] : [],
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      {
        version: "0.8.22",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  etherscan: {
    apiKey: process.env.API_KEY_ETHERSCAN as string, //Single key
  },
  sourcify: {
    enabled: true,
  },
  // watcher: {
  //   compilation: {
  //     tasks: ["compile"],
  //     files: ["./contracts"],
  //     verbose: true,
  //   },
  // },
  contractSizer: {
    alphaSort: true,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
  },
};

export default config;
