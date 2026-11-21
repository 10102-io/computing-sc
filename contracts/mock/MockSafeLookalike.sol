// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev Test only. A contract that answers the two questions the Safe legacy
/// router asks of a Safe (its guard slot, its module list) the way a chosen
/// Safe would, and forwards any call. It is not a Safe and nobody's legacy
/// names it: the router must not take it for the legacy's Safe.
contract MockSafeLookalike {
  address private immutable guard;
  address private immutable module;

  constructor(address guard_, address module_) {
    guard = guard_;
    module = module_;
  }

  function getStorageAt(uint256, uint256) external view returns (bytes memory) {
    return abi.encode(guard);
  }

  function isModuleEnabled(address module_) external view returns (bool) {
    return module_ == module;
  }

  function nonce() external pure returns (uint256) {
    return 0;
  }

  function forward(address to, bytes calldata data) external returns (bytes memory) {
    (bool ok, bytes memory out) = to.call(data);
    if (!ok) {
      assembly {
        revert(add(out, 32), mload(out))
      }
    }
    return out;
  }
}
