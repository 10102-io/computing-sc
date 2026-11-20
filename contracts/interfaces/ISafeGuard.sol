// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.35;

interface ISafeGuard {
  function initialize(address _safeWallet) external;
  function getLastTimestampTxs() external view returns (uint256);

  /// @dev Guards since version 2 (2026-11) only: the Safe's nonce when the
  /// clock last moved. A version 1 guard has no such function.
  function lastNonce() external view returns (uint256);
}
