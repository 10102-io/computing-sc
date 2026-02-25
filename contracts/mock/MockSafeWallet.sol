// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/**
 * Mock Safe wallet for tests. Implements minimal ISafeWallet interface
 * used by LegacyFactory when creating Safe-based legacies.
 */
contract MockSafeWallet {
    address[] internal _owners;
    mapping(address => bool) internal _enabledModules;

    constructor(address[] memory owners_) {
        require(owners_.length > 0, "MockSafeWallet: need at least one owner");
        _owners = owners_;
    }

    /// @notice Returns zero for guard slot (no guard set)
    function getStorageAt(uint256, uint256 length) external pure returns (bytes memory) {
        bytes memory result = new bytes(length * 32);
        return result;
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

    /// @notice Enable a module for _checkSafeWalletValid (used in onlySafeWallet modifier)
    function enableModule(address module) external {
        _enabledModules[module] = true;
    }
}
