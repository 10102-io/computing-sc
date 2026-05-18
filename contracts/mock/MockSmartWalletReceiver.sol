// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface IPremiumRegistryETH {
  function subcribeWithETH(uint256 plan) external payable;
}

/// @notice Stand-in for a smart-contract wallet (Safe, ERC-4337 account, etc.)
/// whose `receive()` does non-trivial work. Pre-v2026.05.18 `PremiumRegistry`
/// refunded ETH overpayments via `payable(msg.sender).transfer(...)` which
/// forwarded only the 2300-gas stipend — enough for a no-op `receive()` but
/// not enough for any real wallet that writes a storage slot or emits an
/// event. Used to exercise the `.call{value:}` refund path (audit finding
/// M-1).
contract MockSmartWalletReceiver {
  event Received(address indexed from, uint256 amount);

  uint256 public receivedCount;
  uint256 public lastAmount;

  /// @dev Non-trivial body: writes two storage slots and emits an event.
  /// Total cost is well over the 2300-gas stipend that `.transfer()`
  /// provides, so this contract MUST receive its refund via `.call`.
  receive() external payable {
    unchecked {
      receivedCount += 1;
    }
    lastAmount = msg.value;
    emit Received(msg.sender, msg.value);
  }

  function subscribe(address registry, uint256 plan) external payable {
    IPremiumRegistryETH(registry).subcribeWithETH{value: msg.value}(plan);
  }
}
