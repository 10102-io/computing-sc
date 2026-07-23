// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import "../interfaces/IPremiumSetting.sol";
import "../interfaces/IPremiumLegacy.sol";
import {ISafeWallet} from "../interfaces/ISafeWallet.sol";
import {NotifyLib} from "../libraries/NotifyLib.sol";

/// @title PremiumReminderView
/// @notice Stateless, read-only re-expression of `PremiumAutomation.checkUpkeep`'s *timing*
/// logic for the Phase B off-chain reminder-worker.
///
/// Phase B retires Chainlink Automation: scheduling + dedup move off-chain into the
/// reminder-worker. This view is the on-chain **trust anchor for *when* a time-based reminder
/// window is open** — the worker polls it and cannot send a reminder earlier than the chain
/// agrees is due. The old `lastNotify` cooldown / "must-notify-before" ordering was pure
/// **dedup state** and is intentionally NOT replicated here: the worker owns the sent-ledger.
///
/// Deployed standalone (no proxy, no storage to upgrade) so it stays off `PremiumSetting`'s
/// bytecode and can be redeployed freely if the worker's needs change.
contract PremiumReminderView {
  /// @dev Safe guard slot — mirrors PremiumAutomation. Used to tell whether a Safe-based
  /// (multisig) legacy is actually "armed" (guard installed); EOA legacies are armed by default.
  bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

  IPremiumSetting public immutable setting;
  /// @dev Fallback notify-ahead window when the creator hasn't set `timePriorActivation`
  /// (mirrors PremiumAutomation.defaultNotifyAhead).
  uint256 public immutable defaultNotifyAhead;

  constructor(address _setting, uint256 _defaultNotifyAhead) {
    require(_setting != address(0), "setting=0");
    setting = IPremiumSetting(_setting);
    defaultNotifyAhead = _defaultNotifyAhead;
  }

  /// @notice The time-based reminder windows currently open for `legacy`, with NO dedup.
  /// Returns empty when the legacy isn't a live, premium-owned, armed legacy. The worker is
  /// responsible for not re-sending a window it has already sent (its sent-ledger).
  function dueReminders(address legacy) public view returns (NotifyLib.NotifyType[] memory) {
    NotifyLib.NotifyType[] memory empty = new NotifyLib.NotifyType[](0);

    address creator = IPremiumLegacy(legacy).creator();
    if (!setting.isPremium(creator)) return empty;
    if (!IPremiumLegacy(legacy).isLive()) return empty;
    if (!_armed(legacy)) return empty;

    uint256 ahead = setting.getTimeAhead(creator);
    if (ahead == 0) ahead = defaultNotifyAhead;

    (uint256 t1, uint256 t2, uint256 t3) = IPremiumLegacy(legacy).getTriggerActivationTimestamp();
    uint8 layer = IPremiumLegacy(legacy).getLayer();
    uint256 nowTs = block.timestamp;

    // At most two windows can be open at once per layer; size 2 buffer then trim.
    NotifyLib.NotifyType[] memory buf = new NotifyLib.NotifyType[](2);
    uint256 k = 0;

    if (layer == 1) {
      if (t2 != t1 && _reached(nowTs, t2, ahead)) buf[k++] = NotifyLib.NotifyType.BeforeLayer2;
      if (nowTs >= t1) buf[k++] = NotifyLib.NotifyType.ReadyToActivate;
      else if (_reached(nowTs, t1, ahead)) buf[k++] = NotifyLib.NotifyType.BeforeActivation;
    } else if (layer == 2) {
      if (t3 != t2 && _reached(nowTs, t3, ahead)) buf[k++] = NotifyLib.NotifyType.BeforeLayer3;
      if (nowTs >= t2) buf[k++] = NotifyLib.NotifyType.Layer2ReadyToActivate;
    } else if (layer == 3) {
      buf[k++] = NotifyLib.NotifyType.Layer3ReadyToActivate;
    }

    NotifyLib.NotifyType[] memory out = new NotifyLib.NotifyType[](k);
    for (uint256 i = 0; i < k; i++) out[i] = buf[i];
    return out;
  }

  /// @notice Batch wrapper so the worker can poll many legacies in one eth_call.
  function dueRemindersBatch(address[] calldata legacies)
    external
    view
    returns (NotifyLib.NotifyType[][] memory results)
  {
    results = new NotifyLib.NotifyType[][](legacies.length);
    for (uint256 i = 0; i < legacies.length; i++) {
      results[i] = dueReminders(legacies[i]);
    }
  }

  /// @dev `nowTs >= target - ahead`, underflow-safe (a view must never revert on arithmetic).
  /// If `target <= ahead` the window opened at/before the epoch, so it's already reached.
  function _reached(uint256 nowTs, uint256 target, uint256 ahead) private pure returns (bool) {
    return target <= ahead || nowTs >= target - ahead;
  }

  function _armed(address legacyAddress) private view returns (bool) {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    if (legacy.LEGACY_TYPE() == 3) return true; // EOA legacy: live-by-default, no Safe guard
    address safeWallet = legacy.getLegacyOwner();
    bytes memory guardBytes = ISafeWallet(safeWallet).getStorageAt(uint256(GUARD_STORAGE_SLOT), 1);
    address guard = address(uint160(uint256(bytes32(guardBytes))));
    return guard != address(0);
  }
}
