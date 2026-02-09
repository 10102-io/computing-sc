// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

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
