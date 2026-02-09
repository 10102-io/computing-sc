// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/**
 * Mock Uniswap V2 Router for tests. Exposes WETH() and getAmountsOut
 * with configurable output for ETH↔token quote tests.
 */
contract MockUniswapV2Router {
    address public immutable weth;
    /// @dev For path [input, output], getAmountsOut returns [amountIn, amountOut].
    /// amountOut is computed as (amountIn * ethToTokenMultiplier) / 1e18 for ETH->token,
    /// or (amountIn * tokenToEthMultiplier) / 1e18 for token->ETH.
    uint256 public ethToTokenMultiplier = 1e18;
    uint256 public tokenToEthMultiplier = 1e18;

    constructor(address _weth) {
        weth = _weth;
    }

    function WETH() external view returns (address) {
        return weth;
    }

    function setEthToTokenMultiplier(uint256 _multiplier) external {
        ethToTokenMultiplier = _multiplier;
    }

    function setTokenToEthMultiplier(uint256 _multiplier) external {
        tokenToEthMultiplier = _multiplier;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockUniswapV2Router: invalid path");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        bool isEthToToken = (path[0] == weth);
        if (isEthToToken) {
            amounts[1] = (amountIn * ethToTokenMultiplier) / 1e18;
        } else {
            amounts[1] = (amountIn * tokenToEthMultiplier) / 1e18;
        }
        for (uint256 i = 2; i < path.length; i++) {
            amounts[i] = amounts[i - 1];
        }
    }
}
