// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ShieldVaultV3} from "../../contracts/shield/ShieldVaultV3.sol";
import {ShieldVaultV3Handler} from "./ShieldVaultV3Handler.sol";

/**
 * @dev Invariant suite for ShieldVault v3: the v2 suite
 * (ShieldVault.invariants.t.sol, invariants I1 to I19 of
 * docs/plans/shield-vault-audit.md) with v3's rules, a fourth token that
 * reports failed transfers after moving all, part or none of them, and one
 * more invariant: fees come from releases only. The handler drives random
 * sequences of every entry point with four owners (one an ERC-1271 wallet),
 * four tokens, an admin, a thief and a relayer, and checks every call's
 * acceptance and effect against the spec. The functions below are checked
 * after every call (docs/security/tooling-report.md section 9).
 *
 *   forge test --match-path "test/foundry/**"           (CI profile)
 *   FOUNDRY_PROFILE=deep forge test --match-contract ShieldVaultV3Invariants
 */
contract ShieldVaultV3Invariants is Test {
  ShieldVaultV3Handler internal h;
  ShieldVaultV3 internal vault;

  function setUp() public {
    h = new ShieldVaultV3Handler();
    vault = h.vaultAddr();
    targetContract(address(h));
    bytes4[] memory selectors = new bytes4[](26);
    selectors[0] = h.open.selector;
    selectors[1] = h.deposit.selector;
    selectors[2] = h.checkIn.selector;
    selectors[3] = h.checkInWithSig.selector;
    selectors[4] = h.requestWithdraw.selector;
    selectors[5] = h.requestChange.selector;
    selectors[6] = h.cancelPending.selector;
    selectors[7] = h.cancelPendingWithSig.selector;
    selectors[8] = h.executePending.selector;
    selectors[9] = h.veto.selector;
    selectors[10] = h.executeFallback.selector;
    selectors[11] = h.claimOwed.selector;
    selectors[12] = h.claimOwedWithSig.selector;
    selectors[13] = h.collectFees.selector;
    selectors[14] = h.adminSetFee.selector;
    selectors[15] = h.adminSetFeeRecipient.selector;
    selectors[16] = h.adminSetTokenSupported.selector;
    selectors[17] = h.adminSetDepositsPaused.selector;
    selectors[18] = h.strangerAdmin.selector;
    selectors[19] = h.setTokenFee.selector;
    selectors[20] = h.setBlocked.selector;
    selectors[21] = h.donate.selector;
    selectors[22] = h.warp.selector;
    selectors[23] = h.decoyOpen.selector;
    selectors[24] = h.armHostile.selector;
    selectors[25] = h.setLie.selector;
    targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
  }

  /// @dev Every per-call acceptance and effect check in the handler (I2, I3,
  /// I4, I5, I7, I8, I9, I10, I14, I17, I18, I19 and the token questions).
  function invariant_handlerSawNoViolation() public view {
    assertEq(h.violations(), 0, h.lastViolation());
  }

  /// @dev I1 and I16: per token, holdings equal balances plus owed plus fees
  /// plus whatever strangers sent straight to the vault.
  function invariant_solvencyPerToken() public view {
    uint256 n = vault.positionCount();
    uint256 payees = h.payeeCount();
    for (uint256 t = 0; t < h.tokenCount(); t++) {
      address tok = h.tokens(t);
      uint256 expected = vault.feesAccrued(tok) + h.ghostDonations(tok);
      for (uint256 id = 1; id <= n; id++) {
        ShieldVaultV3.Position memory p = vault.positionOf(id);
        if (address(p.token) != tok) continue;
        expected += p.balance;
        for (uint256 j = 0; j < payees; j++) expected += vault.owed(id, h.payees(j));
      }
      assertEq(IERC20(tok).balanceOf(address(vault)), expected, "solvency: holdings != balances + owed + fees + donations");
    }
  }

  /// @dev I12: every open position has a balance.
  function invariant_openImpliesFunded() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVaultV3.Position memory p = vault.positionOf(id);
      if (!p.closed) assertGt(p.balance, 0, "open position with zero balance");
      else assertEq(p.balance, 0, "closed position with a balance");
    }
  }

  /// @dev I13 and I3: one pending slot; a fixed-amount withdrawal never
  /// exceeds the balance; readyAt is the one fixed at request time.
  function invariant_pendingConsistency() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVaultV3.Position memory p = vault.positionOf(id);
      if (p.pending.kind == ShieldVaultV3.PendingKind.None) continue;
      assertFalse(p.closed, "closed position with a pending operation");
      assertEq(p.pending.readyAt, h.ghostPendingReadyAt(id), "pending readyAt moved since the request");
      if (p.pending.kind == ShieldVaultV3.PendingKind.Withdraw && p.pending.amount != type(uint256).max) {
        assertLe(p.pending.amount, p.balance, "pending withdrawal exceeds the balance");
      }
      if (p.pending.kind == ShieldVaultV3.PendingKind.Change) {
        assertEq(p.pending.vetoDigest, h.ghostPendingDigest(id), "pending digest moved since the request");
      }
    }
  }

  /// @dev I15: active and pending configs always satisfy the spec's rule.
  function invariant_storedConfigsValid() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVaultV3.Position memory p = vault.positionOf(id);
      assertTrue(h.configValid(p.config, address(p.token)), "stored active config invalid");
      if (p.pending.kind == ShieldVaultV3.PendingKind.Change) {
        assertTrue(h.configValid(p.pending.config, address(p.token)), "stored pending config invalid");
      }
    }
  }

  /// @dev I11: once closed, nothing about the position changes again.
  function invariant_closedIsTerminal() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVaultV3.Position memory p = vault.positionOf(id);
      if (h.ghostClosed(id)) {
        assertTrue(p.closed, "position reopened");
        assertEq(keccak256(abi.encode(p)), h.ghostClosedSnapshot(id), "closed position changed");
      } else {
        assertFalse(p.closed, "position closed outside an exit the handler saw");
      }
    }
  }

  /// @dev I17 and I7: the fee stored at opening never moves and is capped.
  function invariant_feeFixedAtOpen() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVaultV3.Position memory p = vault.positionOf(id);
      assertEq(p.feeBps, h.ghostFeeAtOpen(id), "position fee changed after opening");
      assertLe(p.feeBps, vault.MAX_FEE_BPS(), "position fee above the cap");
    }
    assertLe(vault.feeBps(), vault.MAX_FEE_BPS(), "global fee above the cap");
    assertTrue(vault.feeRecipient() != address(0) && vault.feeRecipient() != address(vault), "fee recipient zero or vault");
  }

  /// @dev I6: per owner, digests ever held by distinct positions are
  /// disjoint, every one of them is pinned for that owner, and a pin is
  /// never cleared. I5: the active digest is one the position has held.
  function invariant_digestsDisjointAndPinned() public view {
    uint256 n = vault.positionCount();
    for (uint256 a = 1; a <= n; a++) {
      ShieldVaultV3.Position memory pa = vault.positionOf(a);
      bytes32[] memory da = h.digestsOf(a);
      bool activeSeen = pa.vetoDigest == bytes32(0);
      for (uint256 i = 0; i < da.length; i++) {
        assertTrue(vault.digestPinned(pa.owner, da[i]), "a held digest is not pinned for its owner");
        if (da[i] == pa.vetoDigest) activeSeen = true;
      }
      assertTrue(activeSeen, "active digest was never pinned by this position");
      for (uint256 b = a + 1; b <= n; b++) {
        ShieldVaultV3.Position memory pb = vault.positionOf(b);
        if (pb.owner != pa.owner) continue;
        bytes32[] memory db = h.digestsOf(b);
        for (uint256 i = 0; i < da.length; i++) {
          for (uint256 j = 0; j < db.length; j++) {
            assertTrue(da[i] != db[j], "two positions of one owner share a digest");
          }
        }
      }
    }
    for (uint256 o = 0; o < h.ownerCount(); o++) {
      address owner = h.owners(o);
      bytes32[] memory pinned = h.pinnedOf(owner);
      for (uint256 i = 0; i < pinned.length; i++) {
        assertTrue(vault.digestPinned(owner, pinned[i]), "a pin was cleared");
      }
    }
  }

  /// @dev v3: per token, every fee the vault ever held came from a release
  /// (`executeFallback`), at the position's rate; withdrawals, vetoes,
  /// changes, cancels and claims added none.
  function invariant_feesOnlyFromReleases() public view {
    for (uint256 t = 0; t < h.tokenCount(); t++) {
      address tok = h.tokens(t);
      assertEq(
        vault.feesAccrued(tok) + h.ghostFeesCollected(tok),
        h.ghostFeesCharged(tok),
        "fees accrued outside a release"
      );
    }
  }

  /// @dev Q11 and the guard: a token with callbacks never gets back into a
  /// guarded function, and never into an owner-only one either.
  function invariant_noReentrancySucceeded() public view {
    assertEq(h.hostileToken().reentrySucceeded(), 0, "a token callback re-entered the vault");
  }

  /// @dev With FUZZ_SUMMARY set to a path under out/, appends this run's
  /// call and acceptance counts per operation, so a campaign's reach can be
  /// summed and reported (docs/security/tooling-report.md).
  function afterInvariant() public {
    string memory path = vm.envOr("FUZZ_SUMMARY", string(""));
    if (bytes(path).length == 0) return;
    vm.createDir("out", true);
    if (!vm.exists(path)) vm.writeFile(path, "");
    h.writeSummary(path);
  }
}
