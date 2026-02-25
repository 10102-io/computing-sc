// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @notice Minimal WETH interface for wrapping/unwrapping ETH 1:1.
interface IWETH {
  function deposit() external payable;
  function withdraw(uint256 amount) external;
}
