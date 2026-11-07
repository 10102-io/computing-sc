// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev Stands in for a legacy router's id-to-legacy record
/// (`legacyAddresses`) in PremiumSetting specs.
contract MockLegacyRegistry {
  mapping(uint256 => address) public legacyAddresses;

  function set(uint256 id, address legacy) external {
    legacyAddresses[id] = legacy;
  }
}
