import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getExternalAddresses } from "../../scripts/utils";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Sets the real Uniswap V2 router on TimeLockRouter and TimelockERC20, configures setTimelock,
 * and adds external USDC/USDT to TokenWhiteList. Runs on Sepolia and mainnet (any network with
 * uniswapRouter configured in external-addresses). Skipped on localhost/hardhat (use 4b.SetMockSwapRouter).
 */
const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network, ethers } = hre;

  const externalAddrs = getExternalAddresses(network.name);
  const { uniswapRouter, usdc, usdt } = externalAddrs;
  if (!uniswapRouter || uniswapRouter === ZERO) {
    throw new Error("uniswapRouter not configured in external-addresses.ts for this network");
  }

  const timeLockRouterDeploy = await deployments.get("TimeLockRouter");
  if (!timeLockRouterDeploy?.address) {
    throw new Error("TimeLockRouter not found. Deploy TimeLockRouter first.");
  }

  const tokenWhiteListDeploy = await deployments.get("TokenWhiteList");
  if (!tokenWhiteListDeploy?.address) {
    throw new Error("TokenWhiteList not found. Deploy TokenWhiteList first.");
  }

  const timelockERC20Deploy = await deployments.get("TimelockERC20");
  const timelockERC721Deploy = await deployments.get("TimelockERC721");
  const timelockERC1155Deploy = await deployments.get("TimelockERC1155");
  if (!timelockERC20Deploy?.address) {
    throw new Error("TimelockERC20 not found. Deploy TimelockERC20 first.");
  }

  const timeLockRouter = await ethers.getContractAt(
    "TimeLockRouter",
    timeLockRouterDeploy.address
  );

  const txSetTimelock = await timeLockRouter.setTimelock(
    timelockERC20Deploy.address,
    timelockERC721Deploy.address,
    timelockERC1155Deploy.address
  );
  await txSetTimelock.wait();
  console.log("TimeLockRouter.setTimelock(ERC20, ERC721, ERC1155) configured");

  const txWhitelist = await timeLockRouter.setTokenWhitelist(tokenWhiteListDeploy.address);
  await txWhitelist.wait();
  console.log("TimeLockRouter.setTokenWhitelist set to:", tokenWhiteListDeploy.address);

  const txRouter = await timeLockRouter.setUniswapRouter(uniswapRouter);
  await txRouter.wait();
  console.log("TimeLockRouter.setUniswapRouter(UniswapV2) set to:", uniswapRouter);

  const timelockERC20 = await ethers.getContractAt(
    "TimelockERC20",
    timelockERC20Deploy.address
  );
  const txERC20 = await timelockERC20.setUniswapRouter(uniswapRouter);
  await txERC20.wait();
  console.log("TimelockERC20.setUniswapRouter(UniswapV2) set to:", uniswapRouter);

  const whitelist = await ethers.getContractAt("TokenWhiteList", tokenWhiteListDeploy.address);
  if (usdc && usdc !== ZERO) {
    if (!(await whitelist.isWhitelisted(usdc))) {
      const txUsdc = await whitelist.addToken(usdc);
      await txUsdc.wait();
      console.log("TokenWhiteList: added USDC", usdc);
    }
  }
  if (usdt && usdt !== ZERO) {
    if (!(await whitelist.isWhitelisted(usdt))) {
      const txUsdt = await whitelist.addToken(usdt);
      await txUsdt.wait();
      console.log("TokenWhiteList: added USDT", usdt);
    }
  }
};

deploy.tags = ["SetSepoliaSwapRouter"];
deploy.dependencies = [
  "TimeLockRouter",
  "TimelockERC20",
  "TimelockERC721",
  "TimelockERC1155",
  "TokenWhiteList",
];
deploy.skip = async (hre: HardhatRuntimeEnvironment) => {
  const { network } = hre;
  if (network.name === "localhost" || network.name === "hardhat") return true;
  try {
    const { uniswapRouter } = getExternalAddresses(network.name);
    return !uniswapRouter || uniswapRouter === ZERO;
  } catch {
    return true;
  }
};

export default deploy;
