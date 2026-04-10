// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @dev Minimal mock Uniswap V2 Router for testing auto-swap flows.
 * Supports both rate-based (setMockRate) and multiplier-based (setEthToTokenMultiplier) configuration.
 * swapExactETHForTokens: transfers outputAmount of outputToken to `to`.
 * swapExactTokensForETH: transfers ETH to `to` scaled by tokenToEthMultiplier.
 * getAmountsOut: returns amounts based on configured multipliers.
 */
contract MockUniswapV2Router {
    using SafeERC20 for IERC20;

    address public immutable WETH;

    // Mapping: output token => mock output amount per 1e18 ETH wei input
    mapping(address => uint256) public mockRate;

    uint256 public ethToTokenMultiplier = 1e18;
    uint256 public tokenToEthMultiplier = 1e18;

    constructor(address weth_) {
        WETH = weth_;
    }

    receive() external payable {}

    function factory() external pure returns (address) {
        return address(0);
    }

    function setMockRate(address token, uint256 rate) external {
        mockRate[token] = rate;
        ethToTokenMultiplier = rate;
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
        // Heuristic: if swapping into WETH, treat it as token->ETH pricing.
        // Otherwise treat it as ETH->token pricing.
        uint256 multiplier = path[1] == WETH ? tokenToEthMultiplier : ethToTokenMultiplier;
        amounts[1] = (amountIn * multiplier) / 1e18;
        for (uint256 i = 2; i < path.length; i++) {
            amounts[i] = amounts[i - 1];
        }
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external payable returns (uint256[] memory amounts) {
        address outputToken = path[path.length - 1];
        uint256 rate = mockRate[outputToken] > 0 ? mockRate[outputToken] : ethToTokenMultiplier;
        uint256 tokenOut = (msg.value * rate) / 1e18;
        require(tokenOut >= amountOutMin, "MockRouter: insufficient output");
        IERC20(outputToken).safeTransfer(to, tokenOut);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = tokenOut;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable {
        require(path.length >= 2, "MockUniswapV2Router: invalid path");
        require(msg.value > 0, "MockUniswapV2Router: no ETH sent");
        address tokenOut = path[1];
        uint256 amountOut = (msg.value * ethToTokenMultiplier) / 1e18;
        uint256 balance = IERC20(tokenOut).balanceOf(address(this));
        uint256 sendAmount = amountOut < balance ? amountOut : balance;
        require(sendAmount > 0, "MockUniswapV2Router: no token balance");
        require(IERC20(tokenOut).transfer(to, sendAmount), "MockUniswapV2Router: transfer failed");
    }

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 /*deadline*/
    ) external returns (uint256[] memory amounts) {
        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 ethOut = (amountIn * tokenToEthMultiplier) / 1e18;
        require(ethOut >= amountOutMin, "MockRouter: insufficient output");
        (bool ok,) = payable(to).call{value: ethOut}("");
        require(ok, "MockRouter: ETH transfer failed");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = ethOut;
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
}
