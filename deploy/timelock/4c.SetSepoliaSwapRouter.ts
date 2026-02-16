import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { getExternalAddresses } from "../../scripts/utils";

/**
 * Sets the real Uniswap V2 router on TimeLockRouter and TimelockERC20 for Sepolia.
 * Skipped on other networks (localhost/hardhat use MockUniswapV2Router via 4b).
 */
const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, network, ethers } = hre;

  const { uniswapRouter } = getExternalAddresses(network.name);
  if (!uniswapRouter || uniswapRouter === "0x0000000000000000000000000000000000000000") {
    throw new Error("Sepolia uniswapRouter not configured in external-addresses.ts");
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
  if (!timelockERC20Deploy?.address) {
    throw new Error("TimelockERC20 not found. Deploy TimelockERC20 first.");
  }

  const timeLockRouter = await ethers.getContractAt(
    "TimeLockRouter",
    timeLockRouterDeploy.address
  );
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
};

deploy.tags = ["SetSepoliaSwapRouter"];
deploy.dependencies = ["TimeLockRouter", "TimelockERC20", "TokenWhiteList"];
deploy.skip = async (hre: HardhatRuntimeEnvironment) => hre.network.name !== "sepolia";

export default deploy;
