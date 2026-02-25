import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts } from "../../scripts/utils";

/** Mint this many raw units (6 decimals) per token to the mock router so ETH→token swaps succeed. */
const MINT_TO_MOCK_RAW_6 = 1_000_000_000 * 10 ** 6;

/** USDC/USDT decimals. Used to set mock multipliers for 1:1 ETH↔token in human terms. */
const TOKEN_DECIMALS = 6;
const ETH_DECIMALS = 18;

/**
 * For 1 ETH (1e18 wei) → 1 USDC (1e6 raw): amountOut = amountIn * ethToTokenMultiplier / 1e18.
 * Want 1e18 * m / 1e18 = 1e6, so ethToTokenMultiplier = 1e6.
 */
const ETH_TO_TOKEN_MULTIPLIER = 10 ** TOKEN_DECIMALS;

/**
 * For 1 USDC (1e6 raw) → 1 ETH (1e18 wei): amountOutEth = amountIn * tokenToEthMultiplier / 1e18.
 * Want 1e6 * m / 1e18 = 1e18, so tokenToEthMultiplier = 1e30.
 * Use string to avoid JS number overflow (1e30 exceeds safe integer range).
 */
const TOKEN_TO_ETH_MULTIPLIER = "1000000000000000000000000000000";

const deploy: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const { deployments, getNamedAccounts, network, ethers } = hre;
  const { deploy: deployContract } = deployments;
  const { deployer } = await getNamedAccounts();

  const isLocal =
    network.name === "localhost" || network.name === "hardhat";
  if (!isLocal) {
    console.log(
      "Skipping mock swap router setup (only for localhost/hardhat)"
    );
    return;
  }

  const timeLockRouterDeploy = await deployments.get("TimeLockRouter");
  if (!timeLockRouterDeploy?.address) {
    throw new Error("TimeLockRouter not found. Deploy TimeLockRouter first.");
  }

  const mockWeth = await deployContract("MockWETH", {
    contract: "ERC20Token",
    from: deployer,
    args: ["Wrapped Ether", "WETH", 18],
    log: true,
    deterministicDeployment: false,
  });

  const mockRouter = await deployContract("MockUniswapV2Router", {
    from: deployer,
    args: [mockWeth.address],
    log: true,
    deterministicDeployment: false,
  });

  const timeLockRouter = await ethers.getContractAt(
    "TimeLockRouter",
    timeLockRouterDeploy.address
  );

  const timelockERC20Deploy = await deployments.get("TimelockERC20");
  const timelockERC721Deploy = await deployments.get("TimelockERC721");
  const timelockERC1155Deploy = await deployments.get("TimelockERC1155");
  const txSetTimelock = await timeLockRouter.setTimelock(
    timelockERC20Deploy.address,
    timelockERC721Deploy.address,
    timelockERC1155Deploy.address
  );
  await txSetTimelock.wait();
  console.log("TimeLockRouter.setTimelock(ERC20, ERC721, ERC1155) configured");

  const tokenWhiteListDeploy = await deployments.get("TokenWhiteList");
  const txSetWhitelist = await timeLockRouter.setTokenWhitelist(
    tokenWhiteListDeploy.address
  );
  await txSetWhitelist.wait();
  console.log("TimeLockRouter.setTokenWhitelist configured");

  const tx = await timeLockRouter.setUniswapRouter(mockRouter.address);
  await tx.wait();
  console.log(
    "TimeLockRouter.setUniswapRouter(MockUniswapV2Router) set to:",
    mockRouter.address
  );

  const timelockERC20 = await ethers.getContractAt(
    "TimelockERC20",
    timelockERC20Deploy.address
  );
  const txTimelock = await timelockERC20.setUniswapRouter(mockRouter.address);
  await txTimelock.wait();
  console.log(
    "TimelockERC20.setUniswapRouter(MockUniswapV2Router) set"
  );

  const mockRouterContract = await ethers.getContractAt(
    "MockUniswapV2Router",
    mockRouter.address
  );
  await mockRouterContract.setEthToTokenMultiplier(ETH_TO_TOKEN_MULTIPLIER);
  await mockRouterContract.setTokenToEthMultiplier(TOKEN_TO_ETH_MULTIPLIER);
  console.log(
    "MockUniswapV2Router multipliers set for 1:1 ETH↔token (6-decimal USDC/USDT)"
  );

  // Prefer deployment artifacts so we fund the tokens actually deployed this run
  const usdcDeploy = await deployments.getOrNull("ERC20Token_USDC");
  const usdtDeploy = await deployments.getOrNull("ERC20Token_USDT");
  const usdcAddress =
    usdcDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDC?.address;
  const usdtAddress =
    usdtDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDT?.address;
  if (!usdcAddress || !usdtAddress) {
    throw new Error(
      "SetMockSwapRouter: ERC20Token_USDC or ERC20Token_USDT not found. " +
        "Ensure TestERC20 runs first (deploy.dependencies includes TestERC20). " +
        "ETH→token timelock swaps will fail without funding the mock router."
    );
  }
  const usdc = await ethers.getContractAt("ERC20Token", usdcAddress);
  const usdt = await ethers.getContractAt("ERC20Token", usdtAddress);
  const amount = ethers.BigNumber.from(String(MINT_TO_MOCK_RAW_6));
  await usdc.mint(mockRouter.address, amount);
  await usdt.mint(mockRouter.address, amount);
  console.log(
    "Funded MockUniswapV2Router with test USDC and USDT for ETH→token swaps"
  );

  await saveContract(network.name, "MockWETH", mockWeth.address);
  await saveContract(network.name, "MockUniswapV2Router", mockRouter.address);
};

deploy.tags = ["SetMockSwapRouter"];
deploy.dependencies = ["TimeLockRouter", "TestERC20"];

export default deploy;
