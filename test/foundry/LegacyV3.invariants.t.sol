// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TransferEOALegacyV3} from "../../contracts/forwarding/TransferLegacyEOAContractV3.sol";
import {MockERC721} from "../../contracts/mock/ERC721Token.sol";
import {MockERC1155} from "../../contracts/mock/ERC1155Token.sol";
import {LegacyV3Handler} from "./LegacyV3Handler.sol";

/**
 * @dev Invariant suite for TransferEOALegacyV3 (docs/security/
 * tooling-report.md, section 8; V1 to V9 below). The handler drives random
 * sequences of deposits, drains, check-ins, every owner setting, executor
 * attestations, token, ETH and NFT claims by every actor (first line,
 * backups inside and outside their windows, second and third lines, the
 * executor, a stranger), NFT approval changes and M-1 unbinds, and checks
 * each call against the spec. The functions below hold after every call.
 *
 *   forge test --match-contract LegacyV3Invariants                  (CI profile)
 *   FOUNDRY_PROFILE=deep forge test --match-contract LegacyV3Invariants
 */
contract LegacyV3Invariants is Test {
  LegacyV3Handler internal h;
  TransferEOALegacyV3 internal legacy;

  function setUp() public {
    h = new LegacyV3Handler();
    h.boot();
    legacy = h.legacy();
    targetContract(address(h));
    bytes4[] memory s = new bytes4[](18);
    s[17] = h.combinedEdit.selector;
    s[15] = h.die.selector;
    s[16] = h.claimAgain.selector;
    s[0] = h.deposit.selector;
    s[1] = h.drain.selector;
    s[2] = h.warp.selector;
    s[3] = h.checkIn.selector;
    s[4] = h.setLines.selector;
    s[5] = h.setItems.selector;
    s[6] = h.setDistributions.selector;
    s[7] = h.setLayers.selector;
    s[8] = h.setExecutor.selector;
    s[9] = h.attest.selector;
    s[10] = h.claim.selector;
    s[11] = h.claimNfts.selector;
    s[12] = h.nftApprovals.selector;
    s[13] = h.unbind.selector;
    s[14] = h.stranger.selector;
    targetSelector(FuzzSelector({addr: address(h), selectors: s}));
  }

  /// @dev V1 (acceptance and effects of every call against the spec): wrong
  /// accepts, wrong refusals, wrong amounts to anyone, a backup claiming
  /// before its window (V5), a second- or third-line claim taking a share
  /// its own line claimed (V4), a stranger or the executor getting through
  /// (V6), units moved differing from the spec (V7).
  function invariant_handlerSawNoViolation() public view {
    assertEq(h.violations(), 0, h.lastViolation());
  }

  /// @dev V2, no over-distribution: per token and ETH, what the owner (or the
  /// legacy, for ETH) holds plus what claims moved out plus what the owner
  /// drained equals everything that came in, and claims moved out exactly
  /// what the model paid. The legacy and the vault never keep tokens.
  function invariant_conservation() public view {
    address pay = h.paymentAddr();
    for (uint256 t; t < 4; ++t) {
      address token = t < 3 ? h.tokenAt(t) : address(0);
      uint256 out = _bal(token, pay);
      for (uint256 i; i < h.actorCount(); ++i) {
        address a = h.actors(i);
        if (a == h.owner()) continue;
        out += _bal(token, a);
      }
      assertEq(out, h.ghostClaimedOut(token), "claims moved out a different amount than the model paid");
      if (token == address(0)) {
        assertEq(address(legacy).balance + out, h.ghostIn(address(0)), "ETH: legacy + paid out != everything in");
      } else {
        uint256 held = IERC20(token).balanceOf(h.owner()) + IERC20(token).balanceOf(h.sink());
        assertEq(held + out, h.ghostIn(token), "tokens: owner + drained + paid out != everything in");
        assertEq(IERC20(token).balanceOf(address(legacy)), 0, "the legacy kept tokens");
        assertEq(IERC20(token).balanceOf(h.vaultAddr()), 0, "the vault kept tokens");
      }
    }
  }

  /// @dev V2 and V3 in per-share mode: the records add up (the shares'
  /// `released` sum to `totalReleased`), and no share has received more
  /// than its percentage of everything that token ever brought in.
  function invariant_perShareEntitlement() public view {
    for (uint256 t; t < 4; ++t) {
      address token = t < 3 ? h.tokenAt(t) : address(0);
      uint256 sum;
      for (uint256 i; i < h.everShareCount(); ++i) {
        address s = h.everShares(i);
        uint256 r = legacy.released(token, s);
        sum += r;
        // Shares change only before activation, when nothing was claimed yet.
        assertLe(r, (h.ghostIn(token) * legacy.getDistribution(1, s)) / 1_000_000, "a share received more than its running-total entitlement");
        assertEq(r, h.mReleased(token, s), "released differs from the model");
      }
      assertEq(sum, legacy.totalReleased(token), "released does not add up to totalReleased");
      assertLe(legacy.totalReleased(token), h.ghostIn(token), "released more than ever came in");
    }
  }

  /// @dev V4 (round 7): a share belongs to the first address it paid, on any
  /// line. `shareOwner` is the model's and equals the first payee the
  /// handler observed; the handler also checks every later payment from the
  /// share went to that address, and that an empty, failed or refused claim
  /// changed no owner.
  function invariant_shareOwnerIsFirstPayee() public view {
    for (uint256 i; i < h.everShareCount(); ++i) {
      address s = h.everShares(i);
      address o = legacy.shareOwner(s);
      assertEq(o, h.mShareOwner(s), "shareOwner differs from the model");
      assertEq(o, h.ghostFirstPayee(s), "the owner is not the first address the share paid");
    }
  }

  /// @dev V6: the executor is never on a line, holds nothing and was never paid.
  function invariant_executorHoldsNothing() public view {
    address x = legacy.executor();
    assertEq(x, h.mExecutor(), "executor differs from the model");
    if (x == address(0)) return;
    // v3's layer counts backups as first line, so 0 also means "not a backup".
    assertEq(legacy.getBeneficiaryLayer(x), 0, "the executor is on a line or a backup");
    // The role only ever goes to `exe`. Unless a run made `exe` a share
    // before naming it executor (setExecutor then refuses it), it holds nothing.
    if (x == h.exe() && !h.wasShare(x)) {
      assertEq(x.balance, 0, "the executor received ETH");
      for (uint256 t; t < 3; ++t) assertEq(IERC20(h.tokenAt(t)).balanceOf(x), 0, "the executor received tokens");
      assertEq(h.nft721().balanceOf(x), 0, "the executor received an ERC-721");
      assertEq(h.nft1155().balanceOf(x, 0) + h.nft1155().balanceOf(x, 1), 0, "the executor received ERC-1155 units");
    }
  }

  /// @dev V7: per item, units moved never exceed units set and are the
  /// model's; per ERC-1155 id, units are conserved across the owner, the
  /// drain sink and the claimants.
  function invariant_nftUnits() public view {
    uint256 n = h.itemCount();
    try legacy.nftItem(n) {
      revert("the legacy has more items than the model");
    } catch {}
    for (uint256 i; i < n; ++i) {
      (TransferEOALegacyV3.NftItem memory item, uint256 moved) = legacy.nftItem(i);
      (, uint256 mMoved) = h.itemAt(i);
      assertLe(moved, item.amount, "an item moved more units than it names");
      assertEq(moved, mMoved, "units moved differ from the model");
    }
    MockERC1155 c = h.nft1155();
    for (uint256 id; id < 2; ++id) {
      uint256 total = c.balanceOf(h.owner(), id) + c.balanceOf(h.sink(), id);
      for (uint256 i; i < h.actorCount(); ++i) if (h.actors(i) != h.owner()) total += c.balanceOf(h.actors(i), id);
      assertEq(total, id == 0 ? h.ghost1155Minted0() : h.ghost1155Minted1(), "ERC-1155 units appeared or vanished");
    }
  }

  /// @dev V8: the clone's configuration is the model's (deadline with the
  /// attestation, per-share mode, shares adding up to 100%).
  function invariant_configMatchesModel() public view {
    (uint256 deadline, , ) = legacy.getTriggerActivationTimestamp();
    assertEq(deadline, h.modelDeadline(), "activation deadline differs from the model");
    assertEq(legacy.backupDelay(), h.mBackupDelay(), "backupDelay differs from the model");
    (address[] memory shares, address l2, address l3) = legacy.getLegacyBeneficiaries();
    assertEq(shares.length, h.shareCount(), "first line differs from the model");
    uint256 sum;
    for (uint256 i; i < shares.length; ++i) {
      assertEq(shares[i], h.shareAt(i), "first-line order differs from the model");
      sum += legacy.getDistribution(1, shares[i]);
    }
    assertEq(l2, h.mL2(), "second line differs from the model");
    assertEq(l3, h.mL3(), "third line differs from the model");
    // Round 8: whole-estate mode may hold a repeated or cross-layer first line
    // (as wave A does; every first-line claim pays everything). Per-share mode
    // never does: nothing may strand there.
    if (legacy.backupDelay() != 0) {
      assertEq(sum, 1_000_000, "per-share mode with first-line shares not adding up to 100%");
      assertEq(legacy.getDistribution(1, l2) + legacy.getDistribution(1, l3), 0, "per-share mode with a first-line primary on the second or third line");
    }
  }

  function _bal(address token, address who) internal view returns (uint256) {
    return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
  }

  /// @dev With FUZZ_SUMMARY set to a path under out/, appends this run's call
  /// and acceptance counts per operation, and the reach counters.
  function afterInvariant() public {
    string memory path = vm.envOr("FUZZ_SUMMARY", string(""));
    if (bytes(path).length == 0) return;
    vm.createDir("out", true);
    if (!vm.exists(path)) vm.writeFile(path, "");
    h.writeSummary(path);
  }
}
