// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IAllowanceTransfer} from "../interfaces/IAllowanceTransfer.sol";
import {IPremiumLegacy} from "../interfaces/IPremiumLegacy.sol";

/**
 * @title LegacyPullVaultV2
 * @notice The single Permit2 spender (and NFT operator) for EOA transfer
 * legacies created from the 2026-11 train on. Same trust model as
 * LegacyPullVault (docs/plans/legacy-pull-vault.md), which keeps serving every
 * legacy bound to it; this vault changes three things (docs/plans/
 * train-2026-11.md):
 *
 * - `unbind()` (checklist audit M-1): an activated legacy stays bound, because
 *   multi-tranche claims keep pulling through it. Its beneficiaries could
 *   front-run the owner's next create, register the owner's new permit
 *   themselves and pull the new allowances through the old legacy. The owner
 *   now clears a non-live binding before signing anything new. A live binding
 *   can never be cleared this way, so a tricked owner cannot silently break
 *   their own inheritance.
 * - Several clone implementations: the codehash allowlist starts with the
 *   implementation given at construction and only the UpgradeTimelock can add
 *   to it (never remove), so the v3 clone joins this vault instead of a third
 *   one. The timelock can already swap the router, which decides what gets
 *   bound, so the allowlist adds no power it did not have.
 * - NFT rails: `pullERC721` / `pullERC1155` move an owner's NFTs for the bound
 *   legacy, so owners approve this one verified operator instead of a fresh
 *   clone address (the drainer fingerprint wallets flag).
 *
 * Unchanged: `bind` is router-only and replaces only a non-live binding;
 * `pull` and `release` only by the bound legacy; no upgrade path; nothing an
 * admin can do to a binding or to funds.
 */
contract LegacyPullVaultV2 {
  /// @notice Canonical Permit2 (same address on every EVM chain).
  IAllowanceTransfer public constant PERMIT2 = IAllowanceTransfer(0x000000000022D473030F116dDEE9F6B43aC78BA3);

  /// @notice The only address allowed to register bindings (the EOA router proxy).
  address public immutable router;

  /// @notice The only address allowed to add a clone implementation.
  address public immutable upgradeTimelock;

  /// @notice EIP-1167 runtime codehash of the implementation given at
  /// construction (kept for LegacyPullVault's getter shape).
  bytes32 public immutable cloneCodehash;

  /// @notice EIP-1167 runtime codehashes whose clones may be bound. Add-only.
  mapping(bytes32 codehash => bool) public isAllowedCodehash;

  /// @notice The legacy contract authorized to pull for each owner.
  mapping(address owner => address legacy) public boundLegacy;

  /* Errors */
  error OnlyRouter();
  error OnlyBoundLegacy();
  error OnlyUpgradeTimelock();
  error NotPinnedClone();
  error OwnerMismatch();
  error AlreadyBound();
  error AlreadyAllowed();
  error NotBound();
  error BoundLegacyLive();
  error ZeroAddress();
  error NoCode();

  /* Events */
  event LegacyBound(address indexed owner, address indexed legacy, address indexed replaced);
  event LegacyReleased(address indexed owner, address indexed legacy);
  event LegacyUnbound(address indexed owner, address indexed legacy);
  event ImplementationAllowed(address indexed implementation, bytes32 codehash);

  /**
   * @param router_ the EOA router PROXY address (stable across upgrades).
   * @param upgradeTimelock_ the UpgradeTimelock, the only party that can add
   *        a further clone implementation.
   * @param implementation_ the first clone implementation this vault serves.
   */
  constructor(address router_, address upgradeTimelock_, address implementation_) {
    if (router_ == address(0) || upgradeTimelock_ == address(0) || implementation_ == address(0)) revert ZeroAddress();
    router = router_;
    upgradeTimelock = upgradeTimelock_;
    cloneCodehash = _allow(implementation_);
  }

  /// @notice EIP-1167 runtime codehash of a clone of `implementation_`.
  function codehashOf(address implementation_) public pure returns (bytes32) {
    // 363d3d373d3d3d363d73 ++ impl ++ 5af43d82803e903d91602b57fd5bf3
    return keccak256(abi.encodePacked(hex"363d3d373d3d3d363d73", implementation_, hex"5af43d82803e903d91602b57fd5bf3"));
  }

  /// @notice Let clones of `implementation_` be bound from now on. Timelock
  /// only, add-only: an allowed implementation can never be removed, so no
  /// later operation can strand a legacy that bound under it.
  function allowImplementation(address implementation_) external {
    if (msg.sender != upgradeTimelock) revert OnlyUpgradeTimelock();
    _allow(implementation_);
  }

  function _allow(address implementation_) private returns (bytes32 codehash) {
    if (implementation_.code.length == 0) revert NoCode();
    codehash = codehashOf(implementation_);
    if (isAllowedCodehash[codehash]) revert AlreadyAllowed();
    isAllowedCodehash[codehash] = true;
    emit ImplementationAllowed(implementation_, codehash);
  }

  /**
   * @dev Bind `owner_` to their freshly created legacy. Called by the router
   * inside the create transaction, after the clone is initialized. Replacing a
   * binding is only allowed when the bound legacy is no longer live.
   */
  function bind(address owner_, address legacy_) external {
    if (msg.sender != router) revert OnlyRouter();
    if (owner_ == address(0) || legacy_ == address(0)) revert ZeroAddress();
    if (!isAllowedCodehash[legacy_.codehash]) revert NotPinnedClone();
    if (IPremiumLegacy(legacy_).getLegacyOwner() != owner_) revert OwnerMismatch();

    address current = boundLegacy[owner_];
    if (current != address(0) && IPremiumLegacy(current).isLive()) revert AlreadyBound();

    boundLegacy[owner_] = legacy_;
    emit LegacyBound(owner_, legacy_, current);
  }

  /// @dev A bound legacy relinquishes its owner's binding (the clone's delete path).
  function release(address owner_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    delete boundLegacy[owner_];
    emit LegacyReleased(owner_, msg.sender);
  }

  /**
   * @notice The owner clears their binding to a legacy that is no longer live
   * (activated or deleted). Call it before signing a permit or an NFT approval
   * for a new legacy: from then on the old legacy can pull nothing through
   * this vault, so its beneficiaries cannot use the new authorization.
   */
  function unbind() external {
    address current = boundLegacy[msg.sender];
    if (current == address(0)) revert NotBound();
    if (IPremiumLegacy(current).isLive()) revert BoundLegacyLive();
    delete boundLegacy[msg.sender];
    emit LegacyUnbound(msg.sender, current);
  }

  /**
   * @dev Pull `amount_` of `token_` from `owner_` to `to_` through Permit2, on
   * behalf of the owner's bound legacy. Permit2 enforces the owner's signed
   * amount and expiration, per owner.
   */
  function pull(address owner_, address token_, address to_, uint160 amount_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    PERMIT2.transferFrom(owner_, to_, amount_, token_);
  }

  /// @dev Move one ERC-721 from `owner_` to `to_` for the owner's bound
  /// legacy; the owner must have approved this vault as operator.
  function pullERC721(address owner_, address collection_, address to_, uint256 tokenId_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    IERC721(collection_).safeTransferFrom(owner_, to_, tokenId_);
  }

  /// @dev Move ERC-1155 units from `owner_` to `to_` for the owner's bound
  /// legacy; the owner must have approved this vault as operator.
  function pullERC1155(address owner_, address collection_, address to_, uint256 id_, uint256 amount_) external {
    if (msg.sender != boundLegacy[owner_]) revert OnlyBoundLegacy();
    IERC1155(collection_).safeTransferFrom(owner_, to_, id_, amount_, "");
  }
}
