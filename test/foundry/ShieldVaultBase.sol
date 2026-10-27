// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {ShieldVault} from "../../contracts/shield/ShieldVault.sol";
import {QuantumRecoveryRegistry} from "../../contracts/common/QuantumRecoveryRegistry.sol";
import {MockAwkwardERC20} from "../../contracts/mock/MockAwkwardERC20.sol";

/// @dev Shared deployment, EIP-712 and config helpers for the ShieldVault
/// fuzz and invariant suites (docs/security/tooling-report.md). Mirrors of
/// the contract's own rules live here so the tests can state what MUST
/// happen independently of the code under test.
abstract contract ShieldVaultBase is Test {
  uint256 internal constant DAY = 86400;
  uint256 internal constant BPS = 10_000;
  uint16 internal constant MAX_FEE_BPS = 50;
  uint8 internal constant SCHEME_HASH_PREIMAGE = 5;
  uint256 internal constant NO_VETO = type(uint256).max;
  uint256 internal constant ALL = type(uint256).max;
  bytes32 internal constant VETO_TAG = keccak256("10102.ShieldVault.veto.v2");

  bytes32 internal constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 id,uint256 nonce,uint256 deadline)");
  bytes32 internal constant CANCEL_TYPEHASH =
    keccak256("CancelPending(uint256 id,uint64 readyAt,uint256 nonce,uint256 deadline)");
  bytes32 internal constant CLAIM_TYPEHASH =
    keccak256("ClaimOwed(uint256 id,address beneficiary,address to,uint256 nonce,uint256 deadline)");

  QuantumRecoveryRegistry internal registry;
  ShieldVault internal vault;
  MockAwkwardERC20 internal token;

  address internal admin = makeAddr("admin");
  address internal treasury = makeAddr("treasury");

  function _deploy(uint16 feeBps) internal {
    registry = new QuantumRecoveryRegistry();
    token = new MockAwkwardERC20();
    address[] memory toks = new address[](1);
    toks[0] = address(token);
    vault = new ShieldVault(registry, admin, toks, treasury, feeBps);
    // The suite moves time forward a lot; start well after the epoch so
    // uint64 timestamps and `deadline - 1` never underflow around zero.
    vm.warp(1_800_000_000);
  }

  function _fund(address who, uint256 amount) internal {
    token.mint(who, amount);
    vm.prank(who);
    token.approve(address(vault), type(uint256).max);
  }

  // ───────────── veto commitment ─────────────

  function _vetoDigest(address owner, bytes32 secret, address recoveryTo) internal view returns (bytes32) {
    return keccak256(abi.encode(VETO_TAG, block.chainid, address(vault), owner, secret, recoveryTo));
  }

  /// @dev Registers a scheme-5 commitment for `owner` and returns its index.
  function _commit(address owner, bytes32 secret, address recoveryTo) internal returns (uint256 index) {
    index = registry.commitmentCount(owner);
    vm.prank(owner);
    registry.register(_vetoDigest(owner, secret, recoveryTo), SCHEME_HASH_PREIMAGE, address(vault));
  }

  // ───────────── EIP-712 ─────────────

  function _typed(bytes32 structHash) internal view returns (bytes32) {
    return MessageHashUtils.toTypedDataHash(vault.domainSeparator(), structHash);
  }

  function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
    (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
    return abi.encodePacked(r, s, v);
  }

  function _signCheckIn(uint256 pk, uint256 id, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
    return _sign(pk, _typed(keccak256(abi.encode(CHECK_IN_TYPEHASH, id, nonce, deadline))));
  }

  function _signCancel(uint256 pk, uint256 id, uint64 readyAt, uint256 nonce, uint256 deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(pk, _typed(keccak256(abi.encode(CANCEL_TYPEHASH, id, readyAt, nonce, deadline))));
  }

  function _signClaim(uint256 pk, uint256 id, address beneficiary, address to, uint256 nonce, uint256 deadline)
    internal
    view
    returns (bytes memory)
  {
    return _sign(pk, _typed(keccak256(abi.encode(CLAIM_TYPEHASH, id, beneficiary, to, nonce, deadline))));
  }

  // ───────────── configs ─────────────

  function _cfg(uint32 exitDelay, uint32 silence, address[] memory bens, uint16[] memory shares, uint16 holdMask)
    internal
    pure
    returns (ShieldVault.Config memory c)
  {
    c.exitDelay = exitDelay;
    c.silencePeriod = silence;
    c.beneficiaries = bens;
    c.sharesBps = shares;
    c.holdMask = holdMask;
  }

  function _noFallback(uint32 exitDelay) internal pure returns (ShieldVault.Config memory) {
    return _cfg(exitDelay, 0, new address[](0), new uint16[](0), 0);
  }

  function _single(uint32 exitDelay, uint32 silence, address ben) internal pure returns (ShieldVault.Config memory) {
    address[] memory bens = new address[](1);
    bens[0] = ben;
    uint16[] memory shares = new uint16[](1);
    shares[0] = 10_000;
    return _cfg(exitDelay, silence, bens, shares, 0);
  }

  /// @dev The spec's validity rule (shield-vault-audit.md invariant 15),
  /// written independently of `_validateConfig`.
  function _configValid(ShieldVault.Config memory c) internal view returns (bool) {
    if (c.exitDelay != 7 days && c.exitDelay != 30 days && c.exitDelay != 90 days) return false;
    uint256 n = c.beneficiaries.length;
    if (n != c.sharesBps.length) return false;
    if (c.silencePeriod == 0) return n == 0 && c.holdMask == 0;
    if (c.silencePeriod < 180 days || c.silencePeriod > 1095 days) return false;
    if (n == 0 || n > 10) return false;
    if (uint256(c.holdMask) >> n != 0) return false;
    uint256 sum;
    for (uint256 i = 0; i < n; i++) {
      address b = c.beneficiaries[i];
      if (b == address(0) || b == address(vault)) return false;
      for (uint256 j = 0; j < i; j++) {
        if (c.beneficiaries[j] == b) return false;
      }
      if (c.sharesBps[i] == 0) return false;
      sum += c.sharesBps[i];
    }
    return sum == BPS;
  }

  function _configHash(ShieldVault.Config memory c) internal pure returns (bytes32) {
    return keccak256(abi.encode(c.exitDelay, c.silencePeriod, c.beneficiaries, c.sharesBps, c.holdMask));
  }

  function _delayFor(uint256 seed) internal pure returns (uint32) {
    uint256 k = seed % 3;
    return k == 0 ? uint32(7 days) : k == 1 ? uint32(30 days) : uint32(90 days);
  }

  /// @dev `n` shares, each at least 1, summing to exactly 10,000.
  function _shares(uint256 n, uint256 seed) internal pure returns (uint16[] memory shares) {
    shares = new uint16[](n);
    uint256 left = BPS;
    for (uint256 i = 0; i < n; i++) {
      uint256 remainingPeople = n - i;
      if (remainingPeople == 1) {
        shares[i] = uint16(left);
      } else {
        uint256 maxHere = left - (remainingPeople - 1);
        uint256 s = 1 + (uint256(keccak256(abi.encode(seed, i))) % maxHere);
        shares[i] = uint16(s);
        left -= s;
      }
    }
  }

  // ───────────── token arithmetic mirrors ─────────────

  /// @dev What `to` receives from the awkward token for a transfer of `amount`.
  function _netOfTokenFee(uint256 amount) internal view returns (uint256) {
    uint256 f = token.feeBps();
    if (f == 0) return amount;
    return amount - (amount * f) / BPS;
  }

  function _fee(uint256 amount, uint16 feeBps) internal pure returns (uint256) {
    return (amount * feeBps) / BPS;
  }
}
