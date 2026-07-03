// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @dev Minimal interface for Uniswap Permit2's AllowanceTransfer API — only
 * the surface Create-flow v2 uses (see docs/plans/create-flow-v2.md §6.8):
 *
 * - `permit`       — router registers the creator's signed batch allowance at
 *                    create time (one off-chain signature replaces N approve txs).
 * - `transferFrom` — the legacy clone (the approved `spender`) pulls tokens
 *                    from the owner's wallet at claim time.
 * - `allowance`    — clone reads the (owner, token, spender) allowance to size
 *                    the claim, exactly like it reads direct ERC-20 allowances.
 * - `lockdown`     — owner-side mass revocation (the user-safety escape hatch).
 *
 * Canonical deployment on every chain we support:
 * 0x000000000022D473030F116dDEE9F6B43aC78BA3
 */
interface IAllowanceTransfer {
  /// @notice Details for a single (token, spender) allowance permit.
  struct PermitDetails {
    address token;
    uint160 amount;
    uint48 expiration;
    uint48 nonce;
  }

  /// @notice Batch of allowance permits for one spender, signed as one EIP-712 payload.
  struct PermitBatch {
    PermitDetails[] details;
    address spender;
    uint256 sigDeadline;
  }

  /// @notice A (token, spender) pair for `lockdown`.
  struct TokenSpenderPair {
    address token;
    address spender;
  }

  function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external;

  function transferFrom(address from, address to, uint160 amount, address token) external;

  function allowance(
    address user,
    address token,
    address spender
  ) external view returns (uint160 amount, uint48 expiration, uint48 nonce);

  function lockdown(TokenSpenderPair[] calldata approvals) external;

  function DOMAIN_SEPARATOR() external view returns (bytes32);
}
