import { DeployFunction } from "hardhat-deploy/dist/types";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { saveContract, getContracts } from "../../scripts/utils";

/** Mint this many raw units (6 decimals) to the mock router so ETH→token swaps succeed. */
const MINT_TO_MOCK_RAW_6 = 100_000 * 10 ** 6;

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

  // Prefer deployment artifacts so we fund the tokens actually deployed this run
  const usdcDeploy = await deployments.getOrNull("ERC20Token_USDC");
  const usdtDeploy = await deployments.getOrNull("ERC20Token_USDT");
  const usdcAddress =
    usdcDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDC?.address;
  const usdtAddress =
    usdtDeploy?.address ??
    getContracts()[network.name]?.ERC20Token_USDT?.address;
  if (usdcAddress && usdtAddress) {
    const usdc = await ethers.getContractAt("ERC20Token", usdcAddress);
    const usdt = await ethers.getContractAt("ERC20Token", usdtAddress);
    const amount = ethers.BigNumber.from(String(MINT_TO_MOCK_RAW_6));
    await usdc.mint(mockRouter.address, amount);
    await usdt.mint(mockRouter.address, amount);
    console.log(
      "Funded MockUniswapV2Router with test USDC and USDT for ETH→token swaps"
    );
  } else {
    console.warn(
      "SetMockSwapRouter: ERC20Token_USDC or ERC20Token_USDT not found. " +
        "Run TestERC20 first (or deploy with tag TestERC20). " +
        "ETH→token timelock swaps will fail until the mock is funded."
    );
  }

  await saveContract(network.name, "MockWETH", mockWeth.address);
  await saveContract(network.name, "MockUniswapV2Router", mockRouter.address);
};

deploy.tags = ["SetMockSwapRouter"];
deploy.dependencies = ["TimeLockRouter", "TestERC20"];

export default deploy;
