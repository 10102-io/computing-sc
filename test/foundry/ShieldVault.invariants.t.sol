// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ShieldVault} from "../../contracts/shield/ShieldVault.sol";
import {ShieldVaultHandler} from "./ShieldVaultHandler.sol";

/**
 * @dev Invariant suite for ShieldVault v2 (docs/plans/shield-vault-audit.md
 * section 4, invariants I1 to I19; the mapping is in
 * docs/security/tooling-report.md). The handler drives random sequences of
 * every entry point with four owners (one an ERC-1271 wallet), three
 * tokens (two with a switchable transfer fee and blocklist, one with
 * callbacks that try to re-enter), an admin, a thief and a relayer, and
 * checks every call's acceptance and effect against the spec. The
 * functions below are checked after every call.
 *
 *   forge test --match-path "test/foundry/**"           (CI profile)
 *   FOUNDRY_PROFILE=deep forge test --match-contract ShieldVaultInvariants
 */
contract ShieldVaultInvariants is Test {
  ShieldVaultHandler internal h;
  ShieldVault internal vault;

  function setUp() public {
    h = new ShieldVaultHandler();
    vault = h.vaultAddr();
    targetContract(address(h));
    bytes4[] memory selectors = new bytes4[](25);
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
        ShieldVault.Position memory p = vault.positionOf(id);
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
      ShieldVault.Position memory p = vault.positionOf(id);
      if (!p.closed) assertGt(p.balance, 0, "open position with zero balance");
      else assertEq(p.balance, 0, "closed position with a balance");
    }
  }

  /// @dev I13 and I3: one pending slot; a fixed-amount withdrawal never
  /// exceeds the balance; readyAt is the one fixed at request time.
  function invariant_pendingConsistency() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVault.Position memory p = vault.positionOf(id);
      if (p.pending.kind == ShieldVault.PendingKind.None) continue;
      assertFalse(p.closed, "closed position with a pending operation");
      assertEq(p.pending.readyAt, h.ghostPendingReadyAt(id), "pending readyAt moved since the request");
      if (p.pending.kind == ShieldVault.PendingKind.Withdraw && p.pending.amount != type(uint256).max) {
        assertLe(p.pending.amount, p.balance, "pending withdrawal exceeds the balance");
      }
      if (p.pending.kind == ShieldVault.PendingKind.Change) {
        assertEq(p.pending.vetoDigest, h.ghostPendingDigest(id), "pending digest moved since the request");
      }
    }
  }

  /// @dev I15: active and pending configs always satisfy the spec's rule.
  function invariant_storedConfigsValid() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVault.Position memory p = vault.positionOf(id);
      assertTrue(h.configValid(p.config), "stored active config invalid");
      if (p.pending.kind == ShieldVault.PendingKind.Change) {
        assertTrue(h.configValid(p.pending.config), "stored pending config invalid");
      }
    }
  }

  /// @dev I11: once closed, nothing about the position changes again.
  function invariant_closedIsTerminal() public view {
    uint256 n = vault.positionCount();
    for (uint256 id = 1; id <= n; id++) {
      ShieldVault.Position memory p = vault.positionOf(id);
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
      ShieldVault.Position memory p = vault.positionOf(id);
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
      ShieldVault.Position memory pa = vault.positionOf(a);
      bytes32[] memory da = h.digestsOf(a);
      bool activeSeen = pa.vetoDigest == bytes32(0);
      for (uint256 i = 0; i < da.length; i++) {
        assertTrue(vault.digestPinned(pa.owner, da[i]), "a held digest is not pinned for its owner");
        if (da[i] == pa.vetoDigest) activeSeen = true;
      }
      assertTrue(activeSeen, "active digest was never pinned by this position");
      for (uint256 b = a + 1; b <= n; b++) {
        ShieldVault.Position memory pb = vault.positionOf(b);
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
    if (bytes(path).length != 0) h.writeSummary(path);
  }
}
