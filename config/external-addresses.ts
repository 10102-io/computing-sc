/**
 * External contract addresses per network (Uniswap, WETH, Chainlink price feeds, etc.).
 * Used by deploy scripts so addresses depend on network/fork instead of being hardcoded.
 *
 * NOTE: Chainlink Automation + Functions (the old on-chain email path) were retired on
 * 2026-06-02 (Phase B) and the operational teardown (upkeep cancellation, Functions
 * subscription closure, LINK withdrawal) completed on both networks. Those config fields
 * have been removed. Chainlink *price feeds* below remain live (PremiumRegistry USD pricing).
 */

const ZERO = "0x0000000000000000000000000000000000000000";

export interface ExternalAddresses {
  /** Uniswap V2 router (or zero on local). */
  uniswapRouter: string;
  /** WETH address (or zero on local). */
  weth: string;
  /** USDT address (Sepolia test token; optional, PremiumRegistry may use deployed mock). */
  usdt: string;
  /** USDC address (Sepolia test token; optional). */
  usdc: string;
  /** Chainlink USDT/USD price feed. */
  usdtUsdPriceFeed: string;
  /** Chainlink USDC/USD price feed. */
  usdcUsdPriceFeed: string;
  /** Chainlink ETH/USD price feed. */
  ethUsdPriceFeed: string;
}

/** External addresses per network name. Add entries for mainnet or other nets as needed. */
export const EXTERNAL_ADDRESSES: Record<string, ExternalAddresses> = {
  hardhat: {
    uniswapRouter: ZERO,
    weth: ZERO,
    usdt: ZERO,
    usdc: ZERO,
    usdtUsdPriceFeed: ZERO,
    usdcUsdPriceFeed: ZERO,
    ethUsdPriceFeed: ZERO,
  },
  localhost: {
    uniswapRouter: ZERO,
    weth: ZERO,
    usdt: ZERO,
    usdc: ZERO,
    usdtUsdPriceFeed: ZERO,
    usdcUsdPriceFeed: ZERO,
    ethUsdPriceFeed: ZERO,
  },
  sepolia: {
    uniswapRouter: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
    weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    usdt: "0x02f62735EaF5fFB56B629bC529e72801713f27cd",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    usdtUsdPriceFeed: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    usdcUsdPriceFeed: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    ethUsdPriceFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  },
  mainnet: {
    uniswapRouter: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdtUsdPriceFeed: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
    usdcUsdPriceFeed: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
    ethUsdPriceFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  },
};
