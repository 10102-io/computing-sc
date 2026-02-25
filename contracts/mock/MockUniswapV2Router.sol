// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev Minimal mock Uniswap V2 Router for testing auto-swap flows.
 * swapExactETHForTokens: transfers outputAmount of outputToken to `to`.
 * swapExactTokensForETH: transfers ETH to `to` (1:1 token-unit to wei, scaled by 1e12 for 6-decimal tokens).
 * getAmountsOut: returns [amountIn, amountIn] (1:1 rate).
 */
contract MockUniswapV2Router {
    using SafeERC20 for IERC20;

    // Mapping: output token => mock output amount per 1e18 ETH wei input
    mapping(address => uint256) public mockRate;

    receive() external payable {}

    function setMockRate(address token, uint256 rate) external {
        mockRate[token] = rate;
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external payable returns (uint256[] memory amounts) {
        address outputToken = path[path.length - 1];
        uint256 rate = mockRate[outputToken] > 0 ? mockRate[outputToken] : 1e18;
        uint256 tokenOut = (msg.value * rate) / 1e18;
        require(tokenOut >= amountOutMin, "MockRouter: insufficient output");
        IERC20(outputToken).safeTransfer(to, tokenOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokenOut;
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        address inputToken = path[0];
        IERC20(inputToken).safeTransferFrom(msg.sender, address(this), amountIn);
        // Scale 6-decimal tokens to ETH: multiply by 1e12
        uint256 ethOut = amountIn * 1e12;
        require(ethOut >= amountOutMin, "MockRouter: insufficient output");
        payable(to).transfer(ethOut);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = ethOut;
    }

    function getAmountsOut(
        uint256 amountIn,
        address[] calldata /*path*/
    ) external pure returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn; // 1:1
    }
}
