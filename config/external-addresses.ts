/**
 * External contract addresses per network (Uniswap, WETH, Chainlink, Verifier term, etc.).
 * Used by deploy scripts so addresses depend on network/fork instead of being hardcoded.
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
  /** Verifier term contract owner / init arg for EIP712LegacyVerifier. */
  verifierTermOwner: string;
  /** Chainlink LINK token. */
  chainlinkLink: string;
  /** Chainlink Automation registrar. */
  chainlinkRegistrar: string;
  /** Chainlink Automation keeper registry. */
  chainlinkKeeperRegistry: string;
  /** Chainlink Functions router. */
  chainlinkFunctionsRouter: string;
  /** Chainlink Functions DON ID (bytes32 hex). */
  chainlinkDonId: string;
  /** Chainlink Functions subscription ID. */
  chainlinkSubscriptionId: number;
  /** Chainlink Automation base gas limit. */
  chainlinkBaseGasLimit: string;
  /** Chainlink Functions gas limit. */
  chainlinkGasLimit: string;
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
    verifierTermOwner: ZERO,
    chainlinkLink: ZERO,
    chainlinkRegistrar: ZERO,
    chainlinkKeeperRegistry: ZERO,
    chainlinkFunctionsRouter: ZERO,
    chainlinkDonId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    chainlinkSubscriptionId: 0,
    chainlinkBaseGasLimit: "1500000",
    chainlinkGasLimit: "300000",
  },
  localhost: {
    uniswapRouter: ZERO,
    weth: ZERO,
    usdt: ZERO,
    usdc: ZERO,
    usdtUsdPriceFeed: ZERO,
    usdcUsdPriceFeed: ZERO,
    ethUsdPriceFeed: ZERO,
    verifierTermOwner: ZERO,
    chainlinkLink: ZERO,
    chainlinkRegistrar: ZERO,
    chainlinkKeeperRegistry: ZERO,
    chainlinkFunctionsRouter: ZERO,
    chainlinkDonId: "0x0000000000000000000000000000000000000000000000000000000000000000",
    chainlinkSubscriptionId: 0,
    chainlinkBaseGasLimit: "1500000",
    chainlinkGasLimit: "300000",
  },
  sepolia: {
    uniswapRouter: "0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008",
    weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9",
    usdt: "0x02f62735EaF5fFB56B629bC529e72801713f27cd",
    usdc: "0xC1Fa197B73577868516dDA2492d44568D9Ec884c",
    usdtUsdPriceFeed: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    usdcUsdPriceFeed: "0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E",
    ethUsdPriceFeed: "0x694AA1769357215DE4FAC081bf1f309aDC325306",
    verifierTermOwner: "0x944A402a91c3D6663f5520bFe23c1c1eE77BCa92",
    chainlinkLink: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
    chainlinkRegistrar: "0xb0E49c5D0d05cbc241d68c05BC5BA1d1B7B72976",
    chainlinkKeeperRegistry: "0x86EFBD0b6736Bed994962f9797049422A3A8E8Ad",
    chainlinkFunctionsRouter: "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0",
    chainlinkDonId: "0x66756e2d657468657265756d2d7365706f6c69612d3100000000000000000000",
    chainlinkSubscriptionId: 5168,
    chainlinkBaseGasLimit: "1500000",
    chainlinkGasLimit: "300000",
  },
};
