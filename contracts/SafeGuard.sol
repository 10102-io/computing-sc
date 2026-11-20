// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.35;

import {Enum} from "@safe-global/safe-smart-account/contracts/common/Enum.sol";
import {BaseGuard} from "@safe-global/safe-smart-account/contracts/base/GuardManager.sol";

/**
 * @title SafeGuard
 * @notice The activity clock of a Safe-based legacy. One guard is deployed
 * per legacy and set as the Safe's transaction guard. The Safe calls it
 * before every transaction it executes, and the guard notes the time and
 * the Safe's nonce.
 *
 * Version 2 (2026-11). Version 1 also accepted a call from any address that
 * carried signatures over the Safe's previous transaction, and its copy of
 * the signature check never asked whether the signers were owners of the
 * Safe, so anyone could move the clock and keep a legacy from activating.
 * Version 2 moves the clock on two occasions only:
 *
 *  - the Safe calls a hook, which it does for a transaction its owners
 *    signed (and, on Safe 1.5.0 with this guard set as the module guard too,
 *    for a transaction of one of its modules);
 *  - anyone calls `sync` while the Safe's nonce is not the one noted, which
 *    is proof that the Safe executed a transaction the guard did not see.
 *
 * The second covers what a guard cannot see. A Safe reads its guard before
 * it executes, so the transaction that sets the guard is not seen by it,
 * and neither is anything the Safe does while the guard is off. The router
 * activates a legacy only when the nonce noted is the Safe's nonce, so an
 * old time never stands for a Safe that has been active since.
 *
 * No hook reverts, so the guard cannot stand between a Safe and its
 * transactions. Guards are not upgradeable; a legacy created before
 * version 2 keeps its guard.
 */
contract SafeGuard is BaseGuard {
  /* Error */
  error SafeGuardInitialized();

  /* State */
  /// @notice 2 since 2026-11. A version 1 guard has no such getter.
  uint256 public constant GUARD_VERSION = 2;

  /// @dev Safe 1.5.0's module guard interface: `checkModuleTransaction`
  /// xor `checkAfterModuleExecution`.
  bytes4 private constant MODULE_GUARD_INTERFACE_ID = 0x58401ed8;

  // One slot: both change with every transaction of the Safe.
  uint128 private _lastTimestamp;
  uint128 private _lastNonce;

  /// @notice The Safe this guard keeps time for.
  address public safeWallet;

  /* Function */
  /**
   * @dev Bind the guard to its Safe and start the clock. Called once by the
   * router, in the transaction that deploys the guard.
   */
  function initialize(address _safeWallet) external {
    if (_lastTimestamp != 0) revert SafeGuardInitialized();
    safeWallet = _safeWallet;
    _noteNow();
  }

  /**
   * @dev The Safe's hook before a transaction executes. The Safe has checked
   * its owners' signatures by then, and the transaction counts whether or
   * not its inner call succeeds. A call from any other address changes
   * nothing.
   */
  function checkTransaction(
    address,
    uint256,
    bytes calldata,
    Enum.Operation,
    uint256,
    uint256,
    uint256,
    address,
    address payable,
    bytes calldata,
    address
  ) external override {
    if (msg.sender == safeWallet) _noteNow();
  }

  /**
   * @dev The Safe's hook after execution. Nothing to do.
   */
  function checkAfterExecution(bytes32, bool) external override {}

  /**
   * @dev Safe 1.5.0's hook before a module's transaction executes, called
   * only when the Safe set this guard as its module guard. A module acts
   * for the Safe without its owners' signatures and without a nonce, so
   * this is how a Safe that is used through a module stays active.
   */
  function checkModuleTransaction(address, uint256, bytes calldata, Enum.Operation, address) external returns (bytes32) {
    if (msg.sender == safeWallet) _noteNow();
    return bytes32(0);
  }

  /**
   * @dev Safe 1.5.0's hook after a module's transaction. Nothing to do.
   */
  function checkAfterModuleExecution(bytes32, bool) external {}

  /**
   * @notice Count a transaction the guard did not see. Open to anyone and
   * without effect unless the Safe's nonce has moved since the guard last
   * noted it; then the Safe was active at some time up to now, and the
   * clock starts again now.
   */
  function sync() external {
    (bool known, uint256 nonce) = _safeNonce();
    if (known && uint128(nonce) != _lastNonce) _note(known, nonce);
  }

  /**
   * @dev The transaction guard and, for Safe 1.5.0, the module guard.
   */
  function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
    return
      interfaceId == 0xe6d7a83a || // the transaction guard (Guard in 1.4.1, ITransactionGuard in 1.5.0)
      interfaceId == MODULE_GUARD_INTERFACE_ID ||
      interfaceId == 0x01ffc9a7; // ERC-165
  }

  /// @notice Time of the last transaction of the Safe that the guard knows
  /// of (of the guard's initialization before the first one).
  function lastTimestampTxs() external view returns (uint256) {
    return _lastTimestamp;
  }

  /**
   * @dev get last timestamp transaction
   */
  function getLastTimestampTxs() external view returns (uint256) {
    return _lastTimestamp;
  }

  /// @notice The Safe's nonce as the guard last read it, which it does each
  /// time the clock moves. Equal to the Safe's nonce as long as the guard
  /// has seen every transaction the Safe's owners signed.
  function lastNonce() external view returns (uint256) {
    return _lastNonce;
  }

  /* Internal */
  /// @dev The Safe's nonce, read without a way to revert: a hook must go
  /// through whatever the address behind `safeWallet` answers.
  function _safeNonce() private view returns (bool known, uint256 nonce) {
    (bool ok, bytes memory out) = safeWallet.staticcall(abi.encodeWithSignature("nonce()"));
    if (ok && out.length == 32) return (true, abi.decode(out, (uint256)));
  }

  /// @dev Note the time and the Safe's nonce as they are now.
  function _noteNow() private {
    (bool known, uint256 nonce) = _safeNonce();
    _note(known, nonce);
  }

  function _note(bool known, uint256 nonce) private {
    _lastTimestamp = uint128(block.timestamp);
    // A Safe's nonce counts its transactions: 2^128 is out of reach.
    if (known) _lastNonce = uint128(nonce);
  }
}
