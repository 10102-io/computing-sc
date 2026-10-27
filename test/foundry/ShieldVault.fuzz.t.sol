// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ShieldVault} from "../../contracts/shield/ShieldVault.sol";
import {ShieldVaultBase} from "./ShieldVaultBase.sol";

/**
 * @dev Stateless property tests for ShieldVault v2. Each test takes one
 * invariant of docs/plans/shield-vault-audit.md section 4 and checks it
 * over random inputs from a fresh deployment. The stateful counterpart is
 * ShieldVault.invariants.t.sol; the mapping is in
 * docs/security/tooling-report.md.
 */
contract ShieldVaultFuzz is ShieldVaultBase {
  uint256 internal ownerPk;
  address internal owner;
  address internal recovery = makeAddr("recovery");
  address internal stranger = makeAddr("stranger");

  function setUp() public {
    (owner, ownerPk) = makeAddrAndKey("owner");
    _deploy(25);
    _fund(owner, 1e30);
    _fund(stranger, 1e30);
  }

  function _openPlain(uint256 amount, ShieldVault.Config memory c) internal returns (uint256 id) {
    vm.prank(owner);
    id = vault.open(IERC20(address(token)), amount, c, NO_VETO, MAX_FEE_BPS);
  }

  // ───────────── I15: config validation is exactly the spec's rule ─────────────

  /// @dev Differential test: `open` accepts a config iff the mirror in the
  /// base accepts it. Random lengths, duplicates, zero and vault addresses,
  /// shares around 10,000, masks around the list length, delays and
  /// silences around the bounds.
  function testFuzz_configValidation(
    uint8 nBens,
    uint8 nShares,
    uint32 exitDelay,
    uint32 silence,
    uint16 holdMask,
    uint256 seed
  ) public {
    nBens = uint8(bound(nBens, 0, 12));
    nShares = uint8(bound(nShares, 0, 12));
    // steer the delay and silence onto their boundaries most of the time
    uint256 k = seed % 10;
    if (k < 6) exitDelay = _delayFor(seed >> 8);
    else if (k == 6) exitDelay = uint32(bound(exitDelay, 7 days - 1, 7 days + 1));
    if ((seed >> 16) % 10 < 5) silence = 0;
    else if ((seed >> 16) % 10 < 8) silence = uint32(bound(silence, 180 days, 1095 days));
    else silence = uint32(bound(silence, 180 days - 2, 1095 days + 2));

    address[] memory bens = new address[](nBens);
    for (uint256 i = 0; i < nBens; i++) {
      uint256 r = uint256(keccak256(abi.encode(seed, "b", i))) % 20;
      if (r == 0) bens[i] = address(0);
      else if (r == 1) bens[i] = address(vault);
      else if (r == 2 && i > 0) bens[i] = bens[i - 1];
      else bens[i] = address(uint160(uint256(keccak256(abi.encode(seed, "ben", i)))));
    }
    uint16[] memory shares = new uint16[](nShares);
    if (nShares > 0) {
      shares = _shares(nShares, seed);
      uint256 r = uint256(keccak256(abi.encode(seed, "s"))) % 10;
      if (r == 0) shares[0] = shares[0] == 0 ? 1 : shares[0] - 1; // sum 9,999
      else if (r == 1 && shares[0] < type(uint16).max) shares[0] = shares[0] + 1; // sum 10,001
      else if (r == 2) shares[nShares - 1] = 0;
    }
    if ((seed >> 32) % 3 == 0) holdMask = uint16(holdMask % (uint16(1) << (nBens > 15 ? 15 : nBens)));

    ShieldVault.Config memory c = _cfg(exitDelay, silence, bens, shares, holdMask);
    bool expected = _configValid(c);
    vm.prank(owner);
    try vault.open(IERC20(address(token)), 1e18, c, NO_VETO, MAX_FEE_BPS) returns (uint256 id) {
      assertTrue(expected, "open accepted a config the spec refuses");
      assertEq(_configHash(vault.positionOf(id).config), _configHash(c), "stored config differs");
    } catch {
      assertFalse(expected, "open refused a config the spec accepts");
    }
  }

  // ───────────── I3: the delay is exact ─────────────

  function testFuzz_withdrawDelayExact(uint256 delaySeed, uint256 amount, uint64 wait, uint8 adminNoise) public {
    uint32 delay = _delayFor(delaySeed);
    amount = bound(amount, 1, 1e24);
    uint256 id = _openPlain(amount, _noFallback(delay));
    vm.prank(owner);
    vault.requestWithdraw(id, amount, stranger);
    uint64 requested = uint64(block.timestamp);
    assertEq(vault.positionOf(id).pending.readyAt, requested + delay, "readyAt != request + delay");

    // admin state must not matter (I7, I8)
    vm.startPrank(admin);
    if (adminNoise & 1 != 0) vault.setDepositsPaused(true);
    if (adminNoise & 2 != 0) vault.setTokenSupported(address(token), false);
    if (adminNoise & 4 != 0) vault.setFee(50);
    vm.stopPrank();

    wait = uint64(bound(wait, 0, uint64(delay) * 2));
    vm.warp(uint256(requested) + wait);
    bool ready = wait >= delay;
    try vault.executePending(id) {
      assertTrue(ready, "executed before readyAt");
      assertEq(vault.positionOf(id).balance, 0);
      assertTrue(vault.positionOf(id).closed, "a full withdrawal closes");
    } catch {
      assertFalse(ready, "refused at or after readyAt");
      assertEq(vault.positionOf(id).balance, amount);
    }
  }

  /// @dev A change to a shorter delay never shortens the operation requested
  /// under the old one, nor the change itself.
  function testFuzz_changeWaitsCurrentDelay(uint256 oldSeed, uint256 newSeed, uint64 wait) public {
    uint32 oldDelay = _delayFor(oldSeed);
    uint32 newDelay = _delayFor(newSeed);
    uint256 id = _openPlain(1e18, _noFallback(oldDelay));
    vm.prank(owner);
    vault.requestChange(id, _noFallback(newDelay), NO_VETO);
    uint64 t0 = uint64(block.timestamp);
    wait = uint64(bound(wait, 0, uint64(oldDelay) + 1 days));
    vm.warp(uint256(t0) + wait);
    try vault.executePending(id) {
      assertGe(wait, oldDelay, "change applied before the old delay ran out");
      assertEq(vault.positionOf(id).config.exitDelay, newDelay);
    } catch {
      assertLt(wait, oldDelay, "change refused after the old delay");
      assertEq(vault.positionOf(id).config.exitDelay, oldDelay, "config changed early");
    }
  }

  // ───────────── I17 and I9: fee and split arithmetic ─────────────

  function testFuzz_withdrawFeeExact(uint16 feeBps, uint256 amount, bool all) public {
    feeBps = uint16(bound(feeBps, 0, MAX_FEE_BPS));
    amount = bound(amount, 1, 1e27);
    vm.prank(admin);
    vault.setFee(feeBps);
    uint256 id = _openPlain(amount, _noFallback(uint32(7 days)));
    assertEq(vault.positionOf(id).feeBps, feeBps, "fee not snapshotted");
    vm.prank(admin);
    vault.setFee(0); // a later change never reaches the position
    vm.prank(owner);
    vault.requestWithdraw(id, all ? ALL : amount, stranger);
    vm.warp(block.timestamp + 7 days);
    uint256 before = token.balanceOf(stranger);
    vault.executePending(id);
    uint256 fee = _fee(amount, feeBps);
    assertEq(vault.feesAccrued(address(token)), fee, "fee != floor(amount*feeBps/1e4)");
    assertEq(token.balanceOf(stranger) - before, amount - fee, "net != amount - fee");
    assertEq(token.balanceOf(address(vault)), fee, "vault keeps exactly the fee");
    assertLe(fee, (amount * MAX_FEE_BPS) / BPS, "fee above the cap");
  }

  function testFuzz_fallbackSplitExact(uint8 n, uint256 shareSeed, uint16 holdMask, uint16 feeBps, uint256 balance) public {
    n = uint8(bound(n, 1, 10));
    feeBps = uint16(bound(feeBps, 0, MAX_FEE_BPS));
    balance = bound(balance, 1, 1e27);
    holdMask = uint16(holdMask % (uint16(1) << n));
    address[] memory bens = new address[](n);
    for (uint256 i = 0; i < n; i++) bens[i] = address(uint160(0xB0B00 + i));
    uint16[] memory shares = _shares(n, shareSeed);
    vm.prank(admin);
    vault.setFee(feeBps);
    uint256 id = _openPlain(balance, _cfg(uint32(7 days), uint32(180 days), bens, shares, holdMask));
    vm.warp(block.timestamp + 180 days);
    vault.executeFallback(id);

    uint256 fee = _fee(balance, feeBps);
    uint256 total = balance - fee;
    uint256 accounted;
    uint256 inVault = fee;
    for (uint256 i = 0; i < n; i++) {
      uint256 expected = i == n - 1 ? total - accounted : (total * shares[i]) / BPS;
      accounted += expected;
      bool held = (uint256(holdMask) >> i) & 1 == 1;
      if (held) {
        assertEq(token.balanceOf(bens[i]), 0, "held share was sent");
        assertEq(vault.owed(id, bens[i]), expected, "held share mis-recorded");
        inVault += expected;
      } else {
        assertEq(token.balanceOf(bens[i]), expected, "share != floor(total*bps/1e4) or remainder");
        assertEq(vault.owed(id, bens[i]), 0);
      }
      // nobody below its floor share, remainder bounded by n - 1 units
      assertGe(expected, (total * shares[i]) / BPS, "below floor share");
      assertLe(expected - (total * shares[i]) / BPS, n - 1, "remainder above n-1 units");
    }
    assertEq(accounted, total, "shares do not sum to total");
    assertEq(token.balanceOf(address(vault)), inVault, "vault holds exactly fee + held shares");
    assertTrue(vault.positionOf(id).closed);
  }

  // ───────────── I5 and I4: digest binding and veto availability ─────────────

  function testFuzz_vetoBindsEveryField(bytes32 secret, address recoveryTo, bytes32 wrongSecret, address wrongTo, uint8 noise) public {
    vm.assume(recoveryTo != address(0) && recoveryTo != address(vault));
    vm.assume(wrongSecret != secret);
    vm.assume(wrongTo != recoveryTo && wrongTo != address(0) && wrongTo != address(vault));
    uint256 index = _commit(owner, secret, recoveryTo);
    vm.prank(owner);
    uint256 id = vault.open(IERC20(address(token)), 5e18, _noFallback(uint32(7 days)), index, MAX_FEE_BPS);

    // noise: pending theft, pause, delisting, blocked recovery wallet, fee change
    if (noise & 1 != 0) {
      vm.prank(owner);
      vault.requestWithdraw(id, ALL, stranger);
    }
    vm.startPrank(admin);
    if (noise & 2 != 0) vault.setDepositsPaused(true);
    if (noise & 4 != 0) vault.setTokenSupported(address(token), false);
    if (noise & 8 != 0) vault.setFee(50);
    vm.stopPrank();
    bool blockedRecovery = noise & 16 != 0;
    if (blockedRecovery) token.setBlocked(recoveryTo, true);

    vm.expectRevert(ShieldVault.WrongSecret.selector);
    vault.veto(id, wrongSecret, recoveryTo);
    vm.expectRevert(ShieldVault.WrongSecret.selector);
    vault.veto(id, secret, wrongTo);
    vm.expectRevert(ShieldVault.InvalidAddress.selector);
    vault.veto(id, secret, address(vault));

    vm.prank(stranger);
    vault.veto(id, secret, recoveryTo);
    ShieldVault.Position memory p = vault.positionOf(id);
    assertTrue(p.closed && p.balance == 0, "veto did not close and empty");
    assertEq(uint8(p.pending.kind), uint8(ShieldVault.PendingKind.None), "pending survived the veto");
    assertEq(vault.feesAccrued(address(token)), 0, "veto charged a fee");
    if (blockedRecovery) assertEq(vault.owed(id, recoveryTo), 5e18, "blocked recovery wallet not owed the full balance");
    else assertEq(token.balanceOf(recoveryTo), 5e18, "recovery wallet not paid the full balance");
  }

  /// @dev I6: a copied digest pinned by a stranger neither burns the owner's
  /// sheet nor lets the owner's secret move the decoy; and the owner
  /// cannot pin one sheet twice.
  function testFuzz_copiedDigestIsHarmless(bytes32 secret, address recoveryTo) public {
    vm.assume(recoveryTo != address(0) && recoveryTo != address(vault));
    uint256 index = _commit(owner, secret, recoveryTo);
    bytes32 digest = _vetoDigest(owner, secret, recoveryTo);
    vm.prank(stranger);
    uint256 copied = registry.register(digest, SCHEME_HASH_PREIMAGE, address(vault));
    vm.prank(stranger);
    uint256 decoy = vault.open(IERC20(address(token)), 1, _noFallback(uint32(7 days)), copied, MAX_FEE_BPS);
    assertFalse(vault.digestPinned(owner, digest), "stranger's pin landed on the owner");

    vm.prank(owner);
    uint256 real = vault.open(IERC20(address(token)), 1e18, _noFallback(uint32(7 days)), index, MAX_FEE_BPS);
    assertTrue(vault.digestPinned(owner, digest));
    vm.prank(owner);
    vm.expectRevert(ShieldVault.CommitmentReused.selector);
    vault.open(IERC20(address(token)), 1e18, _noFallback(uint32(7 days)), index, MAX_FEE_BPS);

    vm.expectRevert(ShieldVault.WrongSecret.selector);
    vault.veto(decoy, secret, recoveryTo);
    vault.veto(real, secret, recoveryTo);
    assertEq(token.balanceOf(recoveryTo), 1e18);
  }

  // ───────────── I18: signatures ─────────────

  function testFuzz_checkInSignatureBindsEverything(uint256 forgerPk, uint64 skew, uint8 mutation) public {
    forgerPk = bound(forgerPk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
    vm.assume(forgerPk != ownerPk);
    uint256 id = _openPlain(1e18, _noFallback(uint32(7 days)));
    vm.warp(block.timestamp + uint256(skew) % (365 days));
    uint256 deadline = block.timestamp + 1 hours;
    uint256 nonce = vault.nonces(owner, 0);
    mutation = uint8(mutation % 6);
    // 0: valid, 1: forged, 2: wrong nonce, 3: wrong id, 4: expired, 5: other chain's domain
    uint256 pk = mutation == 1 ? forgerPk : ownerPk;
    uint256 sigNonce = mutation == 2 ? nonce + 1 : nonce;
    uint256 sigId = mutation == 3 ? id + 1 : id;
    uint256 sigDeadline = mutation == 4 ? block.timestamp - 1 : deadline;
    bytes memory sig;
    if (mutation == 5) {
      bytes32 otherDomain = keccak256(
        abi.encode(
          keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
          keccak256("10102 ShieldVault"),
          keccak256("2"),
          block.chainid + 1,
          address(vault)
        )
      );
      sig = _sign(pk, keccak256(abi.encodePacked("\x19\x01", otherDomain, keccak256(abi.encode(CHECK_IN_TYPEHASH, id, nonce, deadline)))));
    } else {
      sig = _signCheckIn(pk, sigId, sigNonce, sigDeadline);
    }
    uint64 before = vault.positionOf(id).lastActivity;
    vm.prank(stranger);
    try vault.checkInWithSig(id, mutation == 4 ? sigDeadline : deadline, sig) {
      assertEq(mutation, 0, "a mutated signature was accepted");
      assertEq(vault.positionOf(id).lastActivity, uint64(block.timestamp));
      assertEq(vault.nonces(owner, 0), nonce + 1);
      // replay
      vm.prank(stranger);
      vm.expectRevert(ShieldVault.InvalidSignature.selector);
      vault.checkInWithSig(id, deadline, sig);
    } catch {
      assertTrue(mutation != 0, "a valid signature was refused");
      assertEq(vault.positionOf(id).lastActivity, before, "refused signature moved lastActivity");
      assertEq(vault.nonces(owner, 0), nonce, "refused signature consumed a nonce");
    }
  }

  function testFuzz_cancelSignatureBindsReadyAt(uint256 delaySeed, uint64 gap) public {
    uint32 delay = _delayFor(delaySeed);
    uint256 id = _openPlain(1e18, _noFallback(delay));
    vm.prank(owner);
    vault.requestWithdraw(id, 1e18, stranger);
    uint64 first = vault.positionOf(id).pending.readyAt;
    uint256 deadline = block.timestamp + 3650 days;
    bytes memory sigFirst = _signCancel(ownerPk, id, first, 0, deadline);
    // the owner cancels directly, waits `gap`, re-requests
    vm.prank(owner);
    vault.cancelPending(id);
    gap = uint64(bound(gap, 0, 30 days));
    vm.warp(block.timestamp + gap);
    vm.prank(owner);
    vault.requestWithdraw(id, 1e18, stranger);
    uint64 second = vault.positionOf(id).pending.readyAt;
    vm.prank(stranger);
    if (second == first) {
      // same block, same delay: the accepted limitation (Q15b); the stale cancel does cancel
      vault.cancelPendingWithSig(id, deadline, sigFirst);
      assertEq(uint8(vault.positionOf(id).pending.kind), uint8(ShieldVault.PendingKind.None));
    } else {
      vm.expectRevert(ShieldVault.InvalidSignature.selector);
      vault.cancelPendingWithSig(id, deadline, sigFirst);
      assertEq(uint8(vault.positionOf(id).pending.kind), uint8(ShieldVault.PendingKind.Withdraw), "stale cancel cancelled a later operation");
      vm.prank(stranger);
      vault.cancelPendingWithSig(id, deadline, _signCancel(ownerPk, id, second, 0, deadline));
      assertEq(uint8(vault.positionOf(id).pending.kind), uint8(ShieldVault.PendingKind.None));
    }
  }

  // ───────────── I19: held shares ─────────────

  function testFuzz_heldShareMovesOnlyForItsKey(uint256 paperPk, address to, address pusher, uint256 forgerPk) public {
    paperPk = bound(paperPk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
    forgerPk = bound(forgerPk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
    vm.assume(forgerPk != paperPk);
    address paper = vm.addr(paperPk);
    vm.assume(paper.code.length == 0 && paper != address(vault) && paper != address(0));
    vm.assume(to != address(0) && to != address(vault) && to != paper);
    vm.assume(pusher != paper && pusher != address(0) && pusher != address(vault));
    address other = makeAddr("other");
    vm.assume(paper != other);
    address[] memory bens = new address[](2);
    bens[0] = other;
    bens[1] = paper;
    uint16[] memory shares = new uint16[](2);
    shares[0] = 5000;
    shares[1] = 5000;
    uint256 id = _openPlain(10e18, _cfg(uint32(7 days), uint32(180 days), bens, shares, 2));
    vm.warp(block.timestamp + 180 days);
    vault.executeFallback(id);
    uint256 owedBefore = vault.owed(id, paper);
    assertGt(owedBefore, 0, "held share not recorded");
    assertEq(token.balanceOf(paper), 0, "held share was sent");

    // nobody else can push it onto the card's address
    vm.prank(pusher);
    vm.expectRevert(ShieldVault.ShareIsHeld.selector);
    vault.claimOwed(id, paper);
    // a forged signature cannot move it
    uint256 deadline = block.timestamp + 1 hours;
    bytes memory forged = _signClaim(forgerPk, id, paper, to, 0, deadline);
    bytes memory good = _signClaim(paperPk, id, paper, to, 0, deadline);
    vm.expectRevert(ShieldVault.InvalidSignature.selector);
    vault.claimOwedWithSig(id, paper, to, deadline, forged);
    // the card's own signature, to the destination it names, moves exactly the share once
    address elsewhere = makeAddr("elsewhere");
    vm.assume(to != elsewhere);
    vm.expectRevert(ShieldVault.InvalidSignature.selector);
    vault.claimOwedWithSig(id, paper, elsewhere, deadline, good);
    uint256 before = token.balanceOf(to);
    vm.prank(pusher);
    vault.claimOwedWithSig(id, paper, to, deadline, good);
    assertEq(token.balanceOf(to) - before, owedBefore);
    assertEq(vault.owed(id, paper), 0);
    vm.expectRevert(ShieldVault.InvalidSignature.selector);
    vault.claimOwedWithSig(id, paper, to, deadline, good);
  }

  // ───────────── I7: the admin has no reach ─────────────

  function testFuzz_adminCannotReachAPosition(uint8 action, uint16 bps, address recipient, bool flag) public {
    uint256 id = _openPlain(3e18, _single(uint32(7 days), uint32(180 days), stranger));
    vm.prank(owner);
    vault.requestWithdraw(id, 1e18, stranger);
    bytes32 before = keccak256(abi.encode(vault.positionOf(id), vault.owed(id, stranger), vault.nonces(owner, 0)));
    action = uint8(action % 5);
    vm.startPrank(admin);
    if (action == 0) {
      bps = uint16(bound(bps, 0, 60));
      if (bps > MAX_FEE_BPS) vm.expectRevert(ShieldVault.FeeTooHigh.selector);
      vault.setFee(bps);
    } else if (action == 1) {
      if (recipient == address(0) || recipient == address(vault)) vm.expectRevert(ShieldVault.InvalidAddress.selector);
      vault.setFeeRecipient(recipient);
    } else if (action == 2) {
      vault.setDepositsPaused(flag);
    } else if (action == 3) {
      vault.setTokenSupported(address(token), flag);
    } else {
      vault.transferOwnership(stranger);
    }
    vm.stopPrank();
    assertEq(keccak256(abi.encode(vault.positionOf(id), vault.owed(id, stranger), vault.nonces(owner, 0))), before, "admin reached a position");
    // and the exits still work
    vm.warp(block.timestamp + 7 days);
    vault.executePending(id);
    assertEq(vault.positionOf(id).balance, 2e18);
  }

  // ───────────── I1 with a fee-on-transfer token: credited net, debited gross ─────────────

  function testFuzz_feeOnTransferCreditsWhatArrived(uint256 tokenFee, uint256 amount) public {
    tokenFee = bound(tokenFee, 0, BPS);
    amount = bound(amount, 1, 1e27);
    token.setFeeBps(tokenFee);
    uint256 received = amount - (amount * tokenFee) / BPS;
    vm.prank(owner);
    if (received == 0) {
      vm.expectRevert(ShieldVault.NothingReceived.selector);
      vault.open(IERC20(address(token)), amount, _noFallback(uint32(7 days)), NO_VETO, MAX_FEE_BPS);
      return;
    }
    uint256 id = vault.open(IERC20(address(token)), amount, _noFallback(uint32(7 days)), NO_VETO, MAX_FEE_BPS);
    assertEq(vault.positionOf(id).balance, received, "credited more than arrived");
    assertEq(token.balanceOf(address(vault)), received, "vault holds what it credited");
    // paying out debits the vault the gross amount; the payee receives net of the token's fee
    vm.prank(owner);
    vault.requestWithdraw(id, ALL, stranger);
    vm.warp(block.timestamp + 7 days);
    uint256 before = token.balanceOf(stranger);
    vault.executePending(id);
    uint256 fee = _fee(received, 25);
    uint256 net = received - fee;
    assertEq(token.balanceOf(stranger) - before, net - (net * tokenFee) / BPS);
    assertEq(token.balanceOf(address(vault)), fee, "solvency: vault keeps exactly the vault fee");
  }
}
