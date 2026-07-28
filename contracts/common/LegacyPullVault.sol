// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IAllowanceTransfer} from "../interfaces/IAllowanceTransfer.sol";
import {IPremiumLegacy} from "../interfaces/IPremiumLegacy.sol";

/**
 * @title LegacyPullVault
 * @notice The single, permanent Permit2 spender for EOA transfer legacies.
 *
 * Why this exists (docs/plans/legacy-pull-vault.md): before the vault, each
 * creator signed a Permit2 AllowanceTransfer batch whose spender was the
 * CREATE2-predicted clone address. That address has no code at signing time,
 * so wallet security scanners (Blockaid/MetaMask) classify it as an untrusted
 * EOA and show a red "deceptive request" interstitial — the canonical drainer
 * fingerprint — on the happy path of every create. A per-user counterfactual
 * spender can also never be allowlisted, verified, or given an ERC-7730
 * clear-signing descriptor. This vault is the fix: one deployed, verified,
 * named contract that every creator's permit names as spender, while the
 * actual authority to pull stays bound to each owner's own legacy clone.
 *
 * Trust model — deliberately narrower than "router as spender":
 * - The vault is NOT upgradeable and has NO admin. Its behavior is frozen at
 *   deployment.
 * - `pull` only moves (owner → beneficiary) funds when called by the exact
 *   legacy contract bound to that owner, and only through Permit2, which
 *   itself enforces the owner's signed (token, amount, expiration) allowance.
 *   Permit2's accounting is per-owner: the vault can never spend owner A's
 *   allowance for owner B's claim.
 * - `bind` is router-gated AND pinned: the legacy must be a genuine EIP-1167
 *   clone of the implementation this vault was constructed for (codehash
 *   check), must report the claimed owner, and an existing binding is only
 *   replaceable once the bound legacy is no longer live (deleted or fully
 *   activated). First-write-wins protects every owner with an active legacy
 *   even against a hostile router upgrade.
 * - Residual risk, stated honestly: a compromised router/code-admin could
 *   bind a genuine-bytecode clone with attacker-chosen config to an owner who
 *   has NO active binding. That party can already swap the clone
 *   implementation for new creates today, so the vault does not widen the
 *   existing admin trust surface; pair it with a timelocked proxy admin.
 *
 * Rotation: the codehash pin means a future clone implementation requires a
 * new vault deployment (and re-registration with wallet-trust registries).
 * That is intentional — vault and implementation rotate together through the
 * same router wiring (`setLegacyImplementation` + `setPullVault`), and old
 * vault bindings keep serving their existing legacies forever.
 */
contract LegacyPullVault {
  /// @notice Canonical Permit2 (same address on every EVM chain).
  IAllowanceTransfer public constant PERMIT2 =
    IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

  /// @notice The only address allowed to register bindings (the EOA router proxy).
  address public immutable router;

  /// @notice keccak256 of the EIP-1167 runtime bytecode for the pinned clone
  /// implementation. Only genuine clones of that implementation can be bound.
  bytes32 public immutable cloneCodehash;

  /// @notice The legacy contract authorized to pull for each owner.
  mapping(address owner => address legacy) public boundLegacy;

  /* Errors */
  error OnlyRouter();
  error OnlyBoundLegacy();
  error NotPinnedClone();
  error OwnerMismatch();
  error AlreadyBound();
  error ZeroAddress();

  /* Events */
  event LegacyBound(address indexed owner, address indexed legacy, address indexed replaced);
  event LegacyReleased(address indexed owner, address indexed legacy);

  /**
   * @param router_ the EOA router PROXY address (stable across upgrades).
   * @param implementation_ the clone implementation this vault serves; the
   *        EIP-1167 runtime codehash is derived and frozen here.
   */
  constructor(address router_, address implementation_) {
    if (router_ == address(0) || implementation_ == address(0)) revert ZeroAddress();
    router = router_;
    // EIP-1167 runtime bytecode: 363d3d373d3d3d363d73 ++ impl ++ 5af43d82803e903d91602b57fd5bf3
    cloneCodehash = keccak256(
      abi.encodePacked(hex"363d3d373d3d3d363d73", implementation_, hex"5af43d82803e903d91602b57fd5bf3")
    );
  }

  /**
   * @dev Bind `owner_` to their freshly created legacy. Called by the router
   * inside the create transaction, AFTER the clone is initialized (so the
   * owner check below reads real state). Replacing a binding is only allowed
   * when the previously bound legacy is no longer live — an owner with an
   * active legacy can never be re-pointed, even by the router.
   */
  function bind(address owner_, address legacy_) external {
    if (msg.sender != router) revert OnlyRouter();
    if (owner_ == address(0) || legacy_ == address(0)) revert ZeroAddress();
    if (legacy_.codehash != cloneCodehash) revert NotPinnedClone();
    if (IPremiumLegacy(legacy_).getLegacyOwner() != owner_) revert OwnerMismatch();

    address current = boundLegacy[owner_];
    if (current != address(0) && IPremiumLegacy(current).isLive()) revert AlreadyBound();

    boundLegacy[owner_] = legacy_;
    emit LegacyBound(owner_, legacy_, current);
  }

  /**
   * @dev A bound legacy relinquishes its owner's binding (called from the
   * clone's delete path). Only the bound legacy itself can release.
   */
  function release(address owner_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    delete boundLegacy[owner_];
    emit LegacyReleased(owner_, msg.sender);
  }

  /**
   * @dev Pull `amount_` of `token_` from `owner_`'s wallet to `to_` through
   * Permit2, on behalf of the owner's bound legacy. The ONLY caller that can
   * move an owner's funds is that owner's own legacy contract; where the
   * funds go and how much is the legacy's claim logic, capped by the owner's
   * signed Permit2 allowance (amount + expiration) at every step.
   */
  function pull(address owner_, address token_, address to_, uint160 amount_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    PERMIT2.transferFrom(owner_, to_, amount_, token_);
  }
}
