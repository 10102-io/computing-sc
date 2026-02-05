# Hardcoded addresses

Summary of hardcoded addresses in deploy/init scripts and contracts. These are **Sepolia-specific**; for mainnet or other networks, update or parameterize them.

## Deploy scripts (Sepolia)

| File                                         | Addresses                                          | Purpose                                                                    |
| -------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- |
| `deploy/legacy/4.TransferLegacyEOARouter.ts` | `router` 0xC532..., `weth` 0x7b79...               | Uniswap V2 router and WETH on Sepolia. Used if/when initialize is enabled. |
| `deploy/premium/1.PremiumRegistry.ts`        | usdt, usdc, \*UsdPriceFeed, ethUsdPriceFeed        | Sepolia token and Chainlink price feed addresses.                          |
| `deploy/premium/6,7,8` (mail contracts)      | `router` 0xb83E..., `donID` 0x66756e...            | Chainlink Functions router and DON ID for Sepolia.                         |
| `scripts/init/2.set_up_reminder.ts`          | i_link, i_registrar, keeperRegistry, router, donID | Chainlink Automation and Functions for Sepolia.                            |

## Contracts (defaults only)

- **PremiumMailBeforeActivation.sol**, **PremiumMailReadyToActivation.sol**, **PremiumMailActivated.sol** – `router` and `donID` have default values (Sepolia). These are overwritten by `initialize()` in deploy; the deploy scripts pass the same Sepolia values. For another network, change the deploy script args (and/or add env/config).

## Recommendation

For mainnet (or another chain), introduce a small config (e.g. `deploy/config.ts` or env) keyed by `network.name` for: Uniswap router/WETH, Chainlink LINK/registrar/keeper/router/donID, and token/price feed addresses. Use it in deploy and init scripts instead of literals.
