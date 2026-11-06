// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {TransferEOALegacyV3} from "../../contracts/forwarding/TransferLegacyEOAContractV3.sol";
import {TransferLegacyStruct} from "../../contracts/libraries/TransferLegacyStruct.sol";
import {ERC20Token} from "../../contracts/mock/ERC20Token.sol";
import {LegacyV3Base} from "./LegacyV3Base.sol";

/**
 * @dev Stateless properties of the v3 per-share math (docs/security/
 * tooling-report.md, section 8): order independence of the running totals,
 * the cap after the owner's wallet shrank, backup windows to the second,
 * the second line taking only unclaimed shares, and the executor's timing.
 * The test contract is the router.
 */
contract LegacyV3Fuzz is LegacyV3Base {
  ERC20Token internal tok;
  TransferEOALegacyV3 internal legacy;
  address internal owner = makeAddr("owner");
  address internal sink = makeAddr("sink");
  address internal sam = makeAddr("sam");
  address internal tina = makeAddr("tina");
  address internal exe = makeAddr("executor");
  address[3] internal bens;
  address[3] internal backups;

  function setUp() public {
    _deployStack();
    tok = new ERC20Token("Token", "T", 18);
    bens = [makeAddr("alice"), makeAddr("bob"), makeAddr("carol")];
    backups = [makeAddr("alice2"), makeAddr("bob2"), makeAddr("carol2")];
  }

  function _new(uint256[3] memory pct, uint64 backupDelay) internal {
    TransferLegacyStruct.Distribution[] memory d = new TransferLegacyStruct.Distribution[](3);
    for (uint256 i; i < 3; ++i) d[i] = _dist(bens[i], pct[i]);
    legacy = TransferEOALegacyV3(payable(_create(address(v3Impl), 1, owner, d, 180 days, 90 days, sam, tina)));
    vm.prank(owner);
    tok.approve(address(legacy), type(uint256).max);
    if (backupDelay != 0) {
      TransferEOALegacyV3.BackupLine[] memory l = new TransferEOALegacyV3.BackupLine[](3);
      for (uint256 i; i < 3; ++i) l[i] = TransferEOALegacyV3.BackupLine({primary: bens[i], second: backups[i], third: address(0)});
      vm.prank(owner);
      legacy.setBackupLines(backupDelay, l);
    }
  }

  function _pcts(uint256 a, uint256 b) internal pure returns (uint256[3] memory p) {
    p[0] = bound(a, 1, MAX_PERCENT - 2);
    p[1] = bound(b, 1, MAX_PERCENT - p[0] - 1);
    p[2] = MAX_PERCENT - p[0] - p[1];
  }

  function _claim(address who) internal returns (uint256 net) {
    address[] memory assets = new address[](1);
    assets[0] = address(tok);
    uint256 before = tok.balanceOf(who);
    legacy.activeLegacy(assets, false, who);
    // The router's post-checks.
    uint8 layer = legacy.getBeneficiaryLayer(who);
    require(layer != 0 && layer <= legacy.getLayer(), "router would refuse");
    return tok.balanceOf(who) - before;
  }

  function _toDeadline() internal {
    (uint256 deadline, , ) = legacy.getTriggerActivationTimestamp();
    vm.warp(deadline);
  }

  /// @dev Whatever the order of claims and inflows, once every share has
  /// claimed after the last inflow, each has exactly its percentage of
  /// everything that came in, and nothing more left the wallet.
  function testFuzz_runningTotalsOrderIndependent(uint256 a, uint256 b, uint256[4] memory inflow, uint256 order) public {
    uint256[3] memory p = _pcts(a, b);
    _new(p, 30 days);
    _toDeadline();
    uint256 total;
    for (uint256 k; k < 4; ++k) {
      inflow[k] = bound(inflow[k], 0, 1e27);
      tok.mint(owner, inflow[k]);
      total += inflow[k];
      _claim(bens[(order >> (2 * k)) % 3]);
    }
    for (uint256 i; i < 3; ++i) _claim(bens[((order % 3) + i) % 3]);
    uint256 sum;
    for (uint256 i; i < 3; ++i) {
      uint256 r = legacy.released(address(tok), bens[i]);
      assertEq(r, (total * p[i]) / MAX_PERCENT, "a share's running total is not its percentage of all inflows");
      sum += r;
    }
    assertEq(sum, legacy.totalReleased(address(tok)), "released does not add up");
    assertLe(total - sum, 2, "more than rounding dust left behind");
    assertEq(tok.balanceOf(owner), total - sum, "the wallet paid out more than was released");
    uint256 out = tok.balanceOf(address(payment));
    for (uint256 i; i < 3; ++i) out += tok.balanceOf(bens[i]);
    assertEq(out, sum, "beneficiaries plus fees differ from what was released");
  }

  /// @dev The owner's wallet shrinks after the first claim: the next share is
  /// paid what is there, keeps the rest owed, and collects it after an
  /// inflow, never above its percentage of everything that came in.
  function testFuzz_capAfterTheWalletShrank(uint256 deposit, uint256 drained, uint256 refill) public {
    _new([uint256(500_000), 300_000, 200_000], 30 days);
    deposit = bound(deposit, 1e6, 1e27);
    tok.mint(owner, deposit);
    _toDeadline();
    uint256 aliceGross = (deposit * 500_000) / MAX_PERCENT;
    _claim(bens[0]);
    assertEq(legacy.released(address(tok), bens[0]), aliceGross);

    uint256 left = deposit - aliceGross;
    drained = bound(drained, 0, left);
    vm.prank(owner);
    tok.transfer(sink, drained);
    uint256 available = left - drained;
    // The pot is what is there plus what was released: the drain shrank it.
    uint256 bobDue = ((available + aliceGross) * 300_000) / MAX_PERCENT;
    uint256 paid = bobDue < available ? bobDue : available;
    uint256 net = _claim(bens[1]);
    assertEq(legacy.released(address(tok), bens[1]), paid, "the capped share was not paid what was there");
    assertEq(net, paid - _fee(paid), "fee split on a capped claim");

    refill = bound(refill, 0, 1e27);
    tok.mint(owner, refill);
    _claim(bens[1]);
    uint256 pot = tok.balanceOf(owner) + legacy.totalReleased(address(tok));
    uint256 everIn = deposit + refill;
    assertLe(legacy.released(address(tok), bens[1]), (everIn * 300_000) / MAX_PERCENT, "above the running-total entitlement");
    assertLe(legacy.released(address(tok), bens[1]), (pot * 300_000) / MAX_PERCENT + 1, "above the entitlement at the current pot");
    assertLe(legacy.totalReleased(address(tok)), everIn - drained, "released more than the wallet ever had");
  }

  /// @dev A backup's window opens exactly `backupDelay` after the deadline;
  /// before that its claim is refused with the opening time.
  function testFuzz_backupWindowToTheSecond(uint64 delay, uint256 offset) public {
    delay = uint64(bound(delay, 30 days, 90 days));
    _new([uint256(500_000), 300_000, 200_000], delay);
    tok.mint(owner, 1e24);
    (uint256 deadline, , ) = legacy.getTriggerActivationTimestamp();
    offset = bound(offset, 0, 2 * uint256(delay));
    vm.warp(deadline + offset);
    address[] memory assets = new address[](1);
    assets[0] = address(tok);
    if (offset < delay) {
      vm.expectRevert(abi.encodeWithSelector(TransferEOALegacyV3.BackupNotYet.selector, deadline + delay));
      legacy.activeLegacy(assets, false, backups[0]);
    } else {
      assertGt(_claim(backups[0]), 0, "a backup inside its window got nothing");
      assertTrue(legacy.lineClaimed(bens[0]), "the share was not marked as its line's");
    }
  }

  /// @dev In its period the second line takes exactly the unclaimed shares'
  /// dues (capped by what is there) and never a share its line claimed.
  function testFuzz_secondLineTakesOnlyUnclaimedShares(uint256 claimedMask, uint256 d1, uint256 d2, uint256 drained) public {
    _new([uint256(500_000), 300_000, 200_000], 30 days);
    d1 = bound(d1, 1e6, 1e27);
    tok.mint(owner, d1);
    _toDeadline();
    for (uint256 i; i < 3; ++i) if (claimedMask & (1 << i) != 0) _claim(bens[i]);
    d2 = bound(d2, 0, 1e27);
    tok.mint(owner, d2);
    drained = bound(drained, 0, tok.balanceOf(owner));
    vm.prank(owner);
    tok.transfer(sink, drained);

    (, uint256 layer2At, ) = legacy.getTriggerActivationTimestamp();
    vm.warp(layer2At);
    uint256 available = tok.balanceOf(owner);
    uint256 pot = available + legacy.totalReleased(address(tok));
    uint256[3] memory before;
    uint256 owed;
    uint256[3] memory pct = [uint256(500_000), 300_000, 200_000];
    for (uint256 i; i < 3; ++i) {
      before[i] = legacy.released(address(tok), bens[i]);
      if (claimedMask & (1 << i) != 0) continue;
      uint256 e = (pot * pct[i]) / MAX_PERCENT;
      if (e > before[i]) owed += e - before[i];
    }
    uint256 expected = owed < available ? owed : available;
    uint256 net = _claim(sam);
    assertEq(net, expected - _fee(expected), "the second line got a different amount than the unclaimed dues");
    for (uint256 i; i < 3; ++i) {
      if (claimedMask & (1 << i) != 0) assertEq(legacy.released(address(tok), bens[i]), before[i], "the second line took a claimed share");
    }
  }

  /// @dev The executor's attestation counts only after half the trigger of
  /// silence, brings the deadline to 30 days later at most, and any owner
  /// activity cancels it.
  function testFuzz_executorTiming(uint256 silence, uint256 after_) public {
    _new([uint256(500_000), 300_000, 200_000], 0);
    vm.prank(owner);
    legacy.setExecutor(exe);
    (uint256 normal, , ) = legacy.getTriggerActivationTimestamp();
    uint256 start = block.timestamp;
    silence = bound(silence, 0, TRIGGER - 1);
    vm.warp(start + silence);
    vm.prank(exe);
    if (silence < TRIGGER / 2) {
      vm.expectRevert(TransferEOALegacyV3.AttestationNotAllowed.selector);
      legacy.attestDeath();
      return;
    }
    legacy.attestDeath();
    (uint256 shortened, , ) = legacy.getTriggerActivationTimestamp();
    uint256 want = block.timestamp + GRACE < normal ? block.timestamp + GRACE : normal;
    assertEq(shortened, want, "attested deadline");
    after_ = bound(after_, 0, GRACE);
    vm.warp(block.timestamp + after_);
    legacy.activeAlive(owner); // the router's check-in
    (uint256 back, , ) = legacy.getTriggerActivationTimestamp();
    assertEq(back, block.timestamp + TRIGGER, "a check-in did not cancel the attestation");
    assertEq(tok.balanceOf(exe) + exe.balance, 0, "the executor received something");
  }

  /// @dev The floor split itself: the shares never sum above the pot and
  /// leave at most one unit of dust per share.
  function testFuzz_floorSplitNeverExceedsThePot(uint256 pot, uint256 a, uint256 b) public pure {
    pot = bound(pot, 0, 1e60);
    uint256[3] memory p = _pcts(a, b);
    uint256 sum;
    for (uint256 i; i < 3; ++i) sum += (pot * p[i]) / MAX_PERCENT;
    assertLe(sum, pot);
    assertLe(pot - sum, 2);
  }
}
