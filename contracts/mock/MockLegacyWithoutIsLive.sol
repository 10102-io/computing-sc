// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev A legacy the router can claim on that has no `isLive()`. The router
/// asks `isLive()` before a claim to decide whether the claim releases the
/// owner's create flag; this stand-in shows that a legacy which does not
/// answer is still claimable (test/RouterCreateFlag.spec.ts). Its code is
/// planted at a real legacy's address, so the owner is an immutable.
contract MockLegacyWithoutIsLive {
  address private immutable OWNER;

  event Claimed(address beneficiary);

  constructor(address owner_) {
    OWNER = owner_;
  }

  function activeLegacy(address[] calldata, bool, address bene_) external {
    emit Claimed(bene_);
  }

  function activeLegacyAndUnswap(address[] calldata, address bene_, uint256, uint256) external {
    emit Claimed(bene_);
  }

  function eoaStorageToken() external pure returns (address) {
    return address(0);
  }

  function getBeneficiaryLayer(address) external pure returns (uint8) {
    return 1;
  }

  function getLayer() external pure returns (uint8) {
    return 1;
  }

  function getLegacyOwner() external view returns (address) {
    return OWNER;
  }
}
