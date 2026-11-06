// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TransferEOALegacyV3} from "../../contracts/forwarding/TransferLegacyEOAContractV3.sol";
import {TransferEOALegacy} from "../../contracts/forwarding/TransferLegacyEOAContract.sol";
import {TransferLegacyStruct} from "../../contracts/libraries/TransferLegacyStruct.sol";
import {LegacyPullVaultV2} from "../../contracts/common/LegacyPullVaultV2.sol";
import {NftCollectionWhiteList} from "../../contracts/whitelist/NftCollectionWhiteList.sol";
import {MockPermit2} from "../../contracts/mock/MockPermit2.sol";
import {MockWETH9} from "../../contracts/mock/MockWETH9.sol";

/// @dev Every caller is Premium (backup lines, the executor and layers 2
/// and 3 are Premium-gated; the gate itself is covered by the Hardhat specs).
contract MockPremiumAll {
  function isPremium(address) external pure returns (bool) {
    return true;
  }
}

/// @dev Payment as the clone sees it: a fee in basis points and a payee.
contract MockFeePayment {
  uint256 public immutable fee;

  constructor(uint256 fee_) {
    fee = fee_;
  }

  function getFee() external view returns (uint256) {
    return fee;
  }

  receive() external payable {}
}

/// @dev A Uniswap router with no liquidity: `_swapAdminFee` falls back to
/// sending the fee tokens to Payment, so every fee stays countable.
contract NoLiquidityRouter {
  function swapExactTokensForETH(uint256, uint256, address[] calldata, address, uint256) external pure returns (uint256[] memory) {
    revert("no liquidity");
  }
}

/**
 * @dev Shared deployment and spec mirrors for the TransferEOALegacyV3 fuzz and
 * invariant suites (docs/security/tooling-report.md, section 8). The test
 * contract (or handler) is the router: it initializes clones, which records
 * it as `router`, binds them in a LegacyPullVaultV2 it is the router of, and
 * calls the router-only entry points with the router's own checks around
 * them. Mirrors of the spec's rules live here so the suites can state what
 * MUST happen independently of the code under test.
 */
abstract contract LegacyV3Base is Test {
  address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
  uint256 internal constant MAX_PERCENT = 1_000_000;
  uint256 internal constant FEE_BPS = 25;
  uint256 internal constant DAY = 86400;
  uint256 internal constant TRIGGER = 365 days;
  uint256 internal constant GRACE = 30 days;

  MockPremiumAll internal premium;
  MockFeePayment internal payment;
  NoLiquidityRouter internal swapRouter;
  MockWETH9 internal weth;
  NftCollectionWhiteList internal allowlist;
  TransferEOALegacyV3 internal v3Impl;
  TransferEOALegacy internal waveAImpl;
  LegacyPullVaultV2 internal vault;

  /// @dev What the router exposes to a clone's initializer.
  function pullVault() external view returns (address) {
    return address(vault);
  }

  function _deployStack() internal {
    vm.etch(PERMIT2, address(new MockPermit2()).code);
    premium = new MockPremiumAll();
    payment = new MockFeePayment(FEE_BPS);
    swapRouter = new NoLiquidityRouter();
    weth = new MockWETH9();
    allowlist = new NftCollectionWhiteList(address(this));
    v3Impl = new TransferEOALegacyV3(address(allowlist));
    waveAImpl = new TransferEOALegacy();
    vault = new LegacyPullVaultV2(address(this), address(this), address(v3Impl));
    vault.allowImplementation(address(waveAImpl));
    // Uint64 timestamps and `deadline - 1` stay clear of zero.
    vm.warp(1_800_000_000);
  }

  function _dist(address user, uint256 percent) internal pure returns (TransferLegacyStruct.Distribution memory) {
    return TransferLegacyStruct.Distribution({user: user, percent: percent});
  }

  /// @dev A clone of `impl`, initialized and bound as the router's create does.
  function _create(
    address impl,
    uint256 id,
    address owner,
    TransferLegacyStruct.Distribution[] memory dists,
    uint256 delay2,
    uint256 delay3,
    address layer2,
    address layer3
  ) internal returns (address legacy) {
    legacy = Clones.clone(impl);
    TransferLegacyStruct.LegacyExtraConfig memory config = TransferLegacyStruct.LegacyExtraConfig({
      lackOfOutgoingTxRange: TRIGGER,
      delayLayer2: delay2,
      delayLayer3: delay3
    });
    TransferEOALegacy(payable(legacy)).initialize(
      id,
      owner,
      dists,
      config,
      _dist(layer2, layer2 == address(0) ? 0 : MAX_PERCENT),
      _dist(layer3, layer3 == address(0) ? 0 : MAX_PERCENT),
      address(premium),
      address(payment),
      address(swapRouter),
      address(weth)
    );
    vault.bind(owner, legacy);
  }

  // ───────────── spec mirrors ─────────────

  /// @dev The pullable amount of `token` for `legacy`: the larger of the
  /// owner's direct allowance, a Permit2 allowance to the legacy, and a
  /// Permit2 allowance to the vault while the legacy is the bound one,
  /// capped by the owner's balance (docs/plans/legacy-pull-vault.md).
  function _pullable(address token, address owner, address legacy) internal view returns (uint256) {
    uint256 allowance = IERC20(token).allowance(owner, legacy);
    (uint160 a2, uint48 e2, ) = MockPermit2(PERMIT2).allowance(owner, token, legacy);
    if (block.timestamp <= e2 && a2 > allowance) allowance = a2;
    if (vault.boundLegacy(owner) == legacy) {
      (uint160 a3, uint48 e3, ) = MockPermit2(PERMIT2).allowance(owner, token, address(vault));
      if (block.timestamp <= e3 && a3 > allowance) allowance = a3;
    }
    uint256 balance = IERC20(token).balanceOf(owner);
    return balance < allowance ? balance : allowance;
  }

  function _fee(uint256 amount) internal pure returns (uint256) {
    return (amount * FEE_BPS) / 10_000;
  }
}
