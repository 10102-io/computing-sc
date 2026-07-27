// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IAllowanceTransfer} from "../interfaces/IAllowanceTransfer.sol";

/**
 * @dev Faithful test double for the subset of canonical Permit2's
 * AllowanceTransfer that Create-flow v2 uses (create-flow-v2.md §6.8).
 *
 * FIDELITY MATTERS HERE: the EIP-712 domain (name "Permit2", NO version
 * field) and the PermitBatch / PermitDetails typehashes are byte-identical to
 * the real deployment, so the typed-data payloads our tests sign are exactly
 * what production wallets will sign against the canonical
 * 0x000000000022D473030F116dDEE9F6B43aC78BA3. Semantics mirrored: sigDeadline
 * check, per-(owner,token,spender) sequential nonces, expiration==0 meaning
 * "expires at end of this block", uint160-max meaning "don't decrement",
 * AllowanceExpired / InsufficientAllowance on the pull path, and lockdown.
 * Fork tests against the real Permit2 remain the final gate (§13.2).
 */
contract MockPermit2 is IAllowanceTransfer {
  using SafeERC20 for IERC20;

  error SignatureExpired(uint256 signatureDeadline);
  error InvalidNonce();
  error InvalidSigner();
  error AllowanceExpired(uint256 deadline);
  error InsufficientAllowance(uint256 amount);

  struct PackedAllowance {
    uint160 amount;
    uint48 expiration;
    uint48 nonce;
  }

  // owner => token => spender => allowance
  mapping(address => mapping(address => mapping(address => PackedAllowance))) internal _allowances;

  bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
  bytes32 private constant _NAME_HASH = keccak256(bytes("Permit2"));
  bytes32 private constant _PERMIT_DETAILS_TYPEHASH =
    keccak256("PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)");
  bytes32 private constant _PERMIT_BATCH_TYPEHASH =
    keccak256(
      "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)"
    );

  function DOMAIN_SEPARATOR() public view returns (bytes32) {
    return keccak256(abi.encode(_EIP712_DOMAIN_TYPEHASH, _NAME_HASH, block.chainid, address(this)));
  }

  function permit(address owner, PermitBatch memory permitBatch, bytes calldata signature) external {
    if (block.timestamp > permitBatch.sigDeadline) revert SignatureExpired(permitBatch.sigDeadline);

    uint256 n = permitBatch.details.length;
    bytes32[] memory detailHashes = new bytes32[](n);
    for (uint256 i = 0; i < n; ++i) {
      detailHashes[i] = keccak256(abi.encode(_PERMIT_DETAILS_TYPEHASH, permitBatch.details[i]));
    }
    bytes32 structHash = keccak256(
      abi.encode(
        _PERMIT_BATCH_TYPEHASH,
        keccak256(abi.encodePacked(detailHashes)),
        permitBatch.spender,
        permitBatch.sigDeadline
      )
    );
    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    // Real Permit2 accepts EOA + ERC-1271 signers; OZ SignatureChecker matches.
    if (!SignatureChecker.isValidSignatureNow(owner, digest, signature)) revert InvalidSigner();

    for (uint256 i = 0; i < n; ++i) {
      PermitDetails memory d = permitBatch.details[i];
      PackedAllowance storage allowed = _allowances[owner][d.token][permitBatch.spender];
      if (allowed.nonce != d.nonce) revert InvalidNonce();
      allowed.amount = d.amount;
      allowed.expiration = d.expiration == 0 ? uint48(block.timestamp) : d.expiration;
      unchecked {
        allowed.nonce = d.nonce + 1;
      }
    }
  }

  function transferFrom(address from, address to, uint160 amount, address token) external {
    PackedAllowance storage allowed = _allowances[from][token][msg.sender];
    if (block.timestamp > allowed.expiration) revert AllowanceExpired(allowed.expiration);
    uint256 maxAmount = allowed.amount;
    if (maxAmount != type(uint160).max) {
      if (amount > maxAmount) revert InsufficientAllowance(maxAmount);
      unchecked {
        allowed.amount = uint160(maxAmount) - amount;
      }
    }
    IERC20(token).safeTransferFrom(from, to, amount);
  }

  function allowance(
    address user,
    address token,
    address spender
  ) external view returns (uint160 amount, uint48 expiration, uint48 nonce) {
    PackedAllowance storage allowed = _allowances[user][token][spender];
    return (allowed.amount, allowed.expiration, allowed.nonce);
  }

  function lockdown(TokenSpenderPair[] calldata approvals) external {
    for (uint256 i = 0; i < approvals.length; ++i) {
      _allowances[msg.sender][approvals[i].token][approvals[i].spender].amount = 0;
    }
  }
}
