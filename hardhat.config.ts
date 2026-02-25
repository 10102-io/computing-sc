import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "hardhat-contract-sizer";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();

/** Public Sepolia RPC used as default when fork-block.json specifies sepolia and no env RPC is set. */
const DEFAULT_SEPOLIA_RPC = "https://rpc.sepolia.org";

/**
 * Fork block from sync-deployment-artifacts.sh (min startBlock of deployment).
 * Set HARDHAT_NO_FORK=1 (or run `npm run node:fresh`) to start a fresh chain for local deploys
 */
function getForkConfig(): { url: string; blockNumber: number } | null {
  if (process.env.HARDHAT_NO_FORK) return null;
  const forkBlockPath = path.join(__dirname, "fork-block.json");
  if (!fs.existsSync(forkBlockPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(forkBlockPath, "utf-8")) as {
      network?: string;
      blockNumber?: number;
    };
    if (typeof data.blockNumber !== "number") return null;
    const rpc =
      data.network === "sepolia"
        ? (process.env.SEPOLIA_RPC_URL ?? process.env.RPC ?? DEFAULT_SEPOLIA_RPC)
        : (process.env.RPC ?? process.env.SEPOLIA_RPC_URL ?? "");
    if (!rpc) return null;
    return { url: rpc, blockNumber: data.blockNumber };
  } catch {
    return null;
  }
}

const forkConfig = getForkConfig();

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
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
    // Fork at deployment start block when fork-block.json exists and RPC (or SEPOLIA_RPC_URL) is set.
    hardhat: forkConfig
      ? {
        forking: {
          url: forkConfig.url,
          blockNumber: forkConfig.blockNumber
        },
        mining: {
          auto: true,
          interval: 3000
        }
      }
      : {
        mining: {
          auto: true,
          interval: 3000
        }
      },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "",
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
    runOnCompile: false,
    strict: true,
  },
  typechain: {
    dontOverrideCompile: true,
  },
};

export default config;
