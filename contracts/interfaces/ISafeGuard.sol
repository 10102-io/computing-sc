// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

interface ISafeGuard {
  function initialize(address _safeWallet) external;
  function getLastTimestampTxs() external view returns (uint256);
}
