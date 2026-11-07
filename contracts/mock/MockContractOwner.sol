// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev A legacy owner that is a contract (a smart account, or an EOA with an
/// EIP-7702 delegation) whose `receive` costs more than the 2,300-gas stipend
/// `transfer` forwards. Calls anything on behalf of its deployer.
contract MockContractOwner {
  uint256 public received;

  function exec(address target, bytes calldata data) external payable returns (bytes memory ret) {
    bool ok;
    (ok, ret) = target.call{value: msg.value}(data);
    if (!ok) {
      assembly ("memory-safe") {
        revert(add(ret, 32), mload(ret))
      }
    }
  }

  receive() external payable {
    received += msg.value;
  }
}
