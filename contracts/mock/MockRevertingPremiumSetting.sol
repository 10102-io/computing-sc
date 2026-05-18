// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

/// @notice Stub `PremiumSetting` that reverts on every external call the
/// legacy routers make during `createLegacy`. Used exclusively to exercise
/// the router-side try/catch around `setPrivateCodeAndCronjob` introduced in
/// v2026.05.18 (audit finding H-2).
///
/// Only the methods the router invokes during a fresh legacy creation are
/// stubbed — the rest of `IPremiumSetting` is intentionally absent so that
/// any accidental call from the test surface fails loudly.
contract MockRevertingPremiumSetting {
  error MockRevertingPremiumSetting_Revert();

  function setPrivateCodeAndCronjob(address, address) external pure {
    revert MockRevertingPremiumSetting_Revert();
  }

  /// @dev Returns true so the legacy initializer accepts the
  /// premium-only layer2/layer3 config. The scenario under test is
  /// "user is premium, but the downstream cronjob/private-code wiring
  /// fails" — H-2 should let the legacy creation succeed anyway.
  function isPremium(address) external pure returns (bool) {
    return true;
  }
}
