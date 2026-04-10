// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/**
 * Mock Safe wallet for router-onlySafeWallet tests.
 * - Allows setting a "guard" address returned from `getStorageAt` for the Safe guard slot.
 * - Allows enabling modules so `isModuleEnabled` returns true.
 * - Provides helper to call router functions with `msg.sender == safeWallet`.
 */
contract MockSafeWalletWithGuard {
  // Same GUARD_STORAGE_SLOT constant as `LegacyFactory`.
  bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

  address[] internal _owners;
  mapping(address => bool) internal _enabledModules;
  address internal _guard;

  constructor(address[] memory owners_) {
    require(owners_.length > 0, "MockSafeWalletWithGuard: need at least one owner");
    _owners = owners_;
  }

  function setGuard(address guard_) external {
    _guard = guard_;
  }

  function getStorageAt(uint256 slot, uint256 length) external view returns (bytes memory) {
    if (bytes32(slot) == GUARD_STORAGE_SLOT && length == 1) {
      return abi.encode(bytes32(uint256(uint160(_guard))));
    }
    return new bytes(length * 32);
  }

  function getOwners() external view returns (address[] memory) {
    return _owners;
  }

  function isOwner(address owner) external view returns (bool) {
    for (uint256 i = 0; i < _owners.length; i++) {
      if (_owners[i] == owner) return true;
    }
    return false;
  }

  function isModuleEnabled(address module) external view returns (bool) {
    return _enabledModules[module];
  }

  function enableModule(address module) external {
    _enabledModules[module] = true;
  }

  function callRouterSetActivationTrigger(address router, uint256 legacyId, uint256 lackOfOutgoingTxRange) external {
    (bool ok, ) = router.call(abi.encodeWithSignature("setActivationTrigger(uint256,uint256)", legacyId, lackOfOutgoingTxRange));
    require(ok, "MockSafeWalletWithGuard: router call failed");
  }
}

