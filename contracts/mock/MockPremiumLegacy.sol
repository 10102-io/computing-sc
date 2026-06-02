// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "../interfaces/IPremiumLegacy.sol";

/// @dev Minimal IPremiumLegacy stand-in for exercising PremiumSetting's notify triggers in
/// unit tests. Only the getters the triggers actually read are meaningful; the rest return
/// harmless defaults to satisfy the interface.
contract MockPremiumLegacy is IPremiumLegacy {
  address public creatorAddr;
  address public ownerAddr;
  address public routerAddr;
  string public name;
  uint8 public layer;
  uint8 public activatedLayer;

  // Configurable bits for PremiumReminderView tests. Defaults keep the notify-trigger tests
  // (which don't read these) unaffected: LEGACY_TYPE 3 skips the Safe-guard check, live = true.
  uint128 public legacyTypeVal = 3;
  bool public liveVal = true;
  uint256 public t1;
  uint256 public t2;
  uint256 public t3;

  constructor(address _creator, address _owner, address _router, string memory _name, uint8 _layer, uint8 _activatedLayer) {
    creatorAddr = _creator;
    ownerAddr = _owner;
    routerAddr = _router;
    name = _name;
    layer = _layer;
    activatedLayer = _activatedLayer;
  }

  // ── test config setters (used by PremiumReminderView.spec) ───────────────
  function setTriggers(uint256 _t1, uint256 _t2, uint256 _t3) external { t1 = _t1; t2 = _t2; t3 = _t3; }
  function setLegacyType(uint128 _t) external { legacyTypeVal = _t; }
  function setLive(bool _live) external { liveVal = _live; }
  function setLayer(uint8 _layer) external { layer = _layer; }

  // ── reads the triggers actually use ──────────────────────────────────────
  function creator() external view returns (address) { return creatorAddr; }
  function router() external view returns (address) { return routerAddr; }
  function getLegacyOwner() external view returns (address) { return ownerAddr; }
  function getLegacyName() external view returns (string memory) { return name; }
  function getLayer() external view returns (uint8) { return layer; }
  function getBeneficiaryLayer(address) external view returns (uint8) { return activatedLayer; }
  function getLegacyBeneficiaries() external view returns (address[] memory, address, address) {
    return (new address[](0), address(0), address(0));
  }
  function getBeneNickname(address) external view returns (string memory) { return ""; }

  // ── interface filler (unused by the notify path) ─────────────────────────
  function getLegacyInfo() external view returns (uint256, address, uint128) { return (0, address(this), 0); }
  function getActivationTrigger() external pure returns (uint128) { return 0; }
  function getLegacyId() external pure returns (uint256) { return 0; }
  function LEGACY_TYPE() external view returns (uint128) { return legacyTypeVal; }
  function delayLayer2() external pure returns (uint256) { return 0; }
  function delayLayer3() external pure returns (uint256) { return 0; }
  function activeLegacy(address, address[] calldata, bool) external returns (address[] memory assets, uint8 _layer) {
    return (new address[](0), 0);
  }
  function checkActiveLegacy(address) external pure returns (bool) { return false; }
  function getDistribution(uint8, address) external returns (uint256) { return 0; }
  function getBeneficiaries() external pure returns (address[] memory) { return new address[](0); }
  function isLive() external view returns (bool) { return liveVal; }
  function getTriggerActivationTimestamp() external view returns (uint256, uint256, uint256) { return (t1, t2, t3); }
  function getLastTimestamp() external pure returns (uint256) { return 0; }
}
