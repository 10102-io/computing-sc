// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

library TimelockHelper {
  // ───────────── Errors ─────────────
  error ZeroDuration();
  error NotOwner();
  error NotAuthorized();
  error AlreadyUnlocked();
  error StillLocked();
  error NoFundsToWithdraw();
  error NotSoftTimelock();
  error NativeTokenTransferFailed();
  error InvalidTokenType();
  error DuplicateTokenAddresses();
  error ZeroAmount();
  error MismatchedArrayLength();
  error DuplicateTokenAddress();
  error InsufficientNativeToken();
  error ZeroBufferTime();
  error InvalidTokenAmount();
  error InvalidRecipient();
  error NoTokensToLock();
  error TimelockNotLive();
  error InvalidStatus();
  error ExecTransactionFromModuleFailed();
  error NativeLockDeprecated();
  error TokenNotWhitelisted();
  error SwapNotConfigured();
  error InvalidSwapIntent();
  error EthSentWithoutSwap();
  error NoTokensReceived();
  /// @dev A sponsored withdrawal named a payee that can never be right:
  /// the zero address on the router-only path, the router, or a vault.
  error InvalidPayee();

  // ───────────── Enums ─────────────
  enum LockType {
    Regular,
    Soft,
    Gift
  }

  enum LockStatus {
    Null,
    Created,
    Live,
    Ended
  }
}
