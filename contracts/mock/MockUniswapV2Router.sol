// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Mock Uniswap V2 Router for tests. Exposes WETH(), getAmountsOut, and swap
 * functions with configurable multipliers. Tests must fund the mock with ETH
 * for token->ETH swaps and with storage tokens for ETH->token swaps.
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

    receive() external payable {}

    function factory() external pure returns (address) {
        return address(0);
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

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable {
        require(path.length >= 2, "MockUniswapV2Router: invalid path");
        require(path[0] == weth, "MockUniswapV2Router: path[0] must be WETH");
        require(msg.value > 0, "MockUniswapV2Router: no ETH sent");
        address tokenOut = path[1];
        uint256 amountOut = (msg.value * ethToTokenMultiplier) / 1e18;
        uint256 balance = IERC20(tokenOut).balanceOf(address(this));
        uint256 sendAmount = amountOut < balance ? amountOut : balance;
        require(sendAmount > 0, "MockUniswapV2Router: no token balance");
        require(IERC20(tokenOut).transfer(to, sendAmount), "MockUniswapV2Router: transfer failed");
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        require(path.length >= 2, "MockUniswapV2Router: invalid path");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "MockUniswapV2Router: transferFrom failed");
        uint256 amountOutEth = (amountIn * tokenToEthMultiplier) / 1e18;
        uint256 balance = address(this).balance;
        uint256 sendAmount = amountOutEth < balance ? amountOutEth : balance;
        require(sendAmount >= amountOutMin, "MockUniswapV2Router: insufficient output");
        (bool ok,) = payable(to).call{value: sendAmount}("");
        require(ok, "MockUniswapV2Router: ETH transfer failed");
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(path.length >= 2, "MockUniswapV2Router: invalid path");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "MockUniswapV2Router: transferFrom failed");
        uint256 amountOutEth = (amountIn * tokenToEthMultiplier) / 1e18;
        uint256 balance = address(this).balance;
        uint256 sendAmount = amountOutEth < balance ? amountOutEth : balance;
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[1] = sendAmount;
        if (sendAmount > 0) {
            (bool ok,) = payable(to).call{value: sendAmount}("");
            require(ok, "MockUniswapV2Router: ETH transfer failed");
        }
    }
}
