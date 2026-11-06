// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TransferEOALegacy} from "../../contracts/forwarding/TransferLegacyEOAContract.sol";
import {TransferLegacyStruct} from "../../contracts/libraries/TransferLegacyStruct.sol";
import {ERC20Token} from "../../contracts/mock/ERC20Token.sol";
import {MockNoReturnERC20} from "../../contracts/mock/MockNoReturnERC20.sol";
import {MockPermit2} from "../../contracts/mock/MockPermit2.sol";
import {LegacyV3Base, MockFeePayment} from "./LegacyV3Base.sol";

/**
 * @dev Differential handler (V9): a v3 legacy that never turns on per-share
 * mode against a wave A legacy, twin owners and twin beneficiaries, the same
 * deposits, drains, check-ins, first-line and layer edits, time and claims
 * in lockstep. Both must accept or refuse together and pay the twins the
 * same amounts, on every rail.
 */
contract WholeEstateHandler is LegacyV3Base {
  TransferEOALegacy public v3;
  TransferEOALegacy public a;
  MockFeePayment public paymentA;
  address[2] public owners;
  address[2] public sinks;
  address[6][2] internal people; // alice, bob, carol, dave, sam, tina, per legacy
  ERC20Token internal tokA;
  MockNoReturnERC20 internal tokB;
  ERC20Token internal tokC;
  address[3] internal tokens;

  uint256 public violations;
  string public lastViolation;
  uint256 public claimsCompared;
  uint256 public claimsAccepted;
  uint256 public combinedCompared;
  uint256 public combinedAccepted;

  constructor() {
    _deployStack();
    tokA = new ERC20Token("Token A", "A", 18);
    tokB = new MockNoReturnERC20("Tether-like", "B", 6);
    tokC = new ERC20Token("Token C", "C", 18);
    tokens = [address(tokA), address(tokB), address(tokC)];
    string[6] memory names = ["alice", "bob", "carol", "dave", "sam", "tina"];
    for (uint256 s; s < 2; ++s) {
      owners[s] = makeAddr(string.concat("owner", vm.toString(s)));
      sinks[s] = makeAddr(string.concat("sink", vm.toString(s)));
      for (uint256 i; i < 6; ++i) people[s][i] = makeAddr(string.concat(names[i], vm.toString(s)));
    }
  }

  function boot() external {
    require(address(v3) == address(0));
    v3 = TransferEOALegacy(payable(_create(address(v3Impl), 1, owners[0], _distSet(0, 0), 180 days, 90 days, people[0][4], people[0][5])));
    MockFeePayment p0 = payment;
    paymentA = new MockFeePayment(FEE_BPS);
    payment = paymentA;
    a = TransferEOALegacy(payable(_create(address(waveAImpl), 2, owners[1], _distSet(1, 0), 180 days, 90 days, people[1][4], people[1][5])));
    payment = p0;
    TransferEOALegacy[2] memory ls = [v3, a];
    for (uint256 s; s < 2; ++s) {
      vm.startPrank(owners[s]);
      tokA.approve(address(ls[s]), type(uint256).max);
      tokB.approve(address(ls[s]), type(uint256).max);
      tokC.approve(PERMIT2, type(uint256).max);
      MockPermit2(PERMIT2).approve(address(tokC), address(vault), type(uint160).max, type(uint48).max);
      vm.stopPrank();
    }
  }

  function _distSet(uint256 s, uint256 k) internal view returns (TransferLegacyStruct.Distribution[] memory d) {
    k %= 4;
    if (k == 0) {
      d = new TransferLegacyStruct.Distribution[](3);
      (d[0], d[1], d[2]) = (_dist(people[s][0], 500_000), _dist(people[s][1], 300_000), _dist(people[s][2], 200_000));
    } else if (k == 1) {
      d = new TransferLegacyStruct.Distribution[](2);
      (d[0], d[1]) = (_dist(people[s][1], 333_333), _dist(people[s][3], 666_667));
    } else if (k == 2) {
      d = new TransferLegacyStruct.Distribution[](1);
      d[0] = _dist(people[s][2], MAX_PERCENT);
    } else {
      d = new TransferLegacyStruct.Distribution[](3);
      (d[0], d[1], d[2]) = (_dist(people[s][3], 1), _dist(people[s][0], 999_998), _dist(people[s][1], 1));
    }
  }

  function _fail(string memory why) internal {
    violations += 1;
    lastViolation = why;
  }

  function _legacy(uint256 s) internal view returns (TransferEOALegacy) {
    return s == 0 ? v3 : a;
  }

  function _pay(uint256 s) internal view returns (address) {
    return s == 0 ? address(payment) : address(paymentA);
  }

  function _bal(address token, address who) internal view returns (uint256) {
    return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
  }

  /// @dev Both twins' visible state, side by side; a difference is a violation.
  function _compareState() internal {
    (uint256 a1, uint256 a2, uint256 a3) = v3.getTriggerActivationTimestamp();
    (uint256 b1, uint256 b2, uint256 b3) = a.getTriggerActivationTimestamp();
    if (a1 != b1 || a2 != b2 || a3 != b3) _fail("activation timestamps differ");
    if (v3.getLayer() != a.getLayer()) _fail("current layer differs");
    if (v3.isLive() != a.isLive() || v3.getIsActiveLegacy() != a.getIsActiveLegacy()) _fail("liveness differs");
    if (address(v3).balance != address(a).balance) _fail("ETH held differs");
    for (uint256 t; t < 4; ++t) {
      address token = t < 3 ? tokens[t] : address(0);
      if (_bal(token, _pay(0)) != _bal(token, _pay(1))) _fail("fees differ");
      if (token != address(0) && _bal(token, owners[0]) != _bal(token, owners[1])) _fail("owner balances differ");
      for (uint256 i; i < 6; ++i) if (_bal(token, people[0][i]) != _bal(token, people[1][i])) _fail("a twin received a different amount");
    }
  }

  // ───────────── lockstep actions ─────────────

  function deposit(uint256 tSeed, uint256 amount) external {
    uint256 t = tSeed % 4;
    if (t == 3) {
      amount = bound(amount, 1, 5 ether);
      address funder = makeAddr("funder");
      vm.deal(funder, 2 * amount);
      vm.startPrank(funder);
      (bool s0, ) = address(v3).call{value: amount}("");
      (bool s1, ) = address(a).call{value: amount}("");
      vm.stopPrank();
      if (s0 != s1) _fail("ETH deposit accepted by one twin only");
    } else {
      amount = bound(amount, 1, t == 1 ? 1e15 : 1e27);
      for (uint256 s; s < 2; ++s) {
        if (t == 1) tokB.mint(owners[s], amount);
        else ERC20Token(tokens[t]).mint(owners[s], amount);
      }
    }
    _compareState();
  }

  function drain(uint256 tSeed, uint256 amount) external {
    uint256 t = tSeed % 3;
    uint256 have = _bal(tokens[t], owners[0]);
    if (have == 0) return;
    amount = bound(amount, 1, have);
    for (uint256 s; s < 2; ++s) {
      vm.prank(owners[s]);
      if (t == 1) tokB.transfer(sinks[s], amount);
      else IERC20(tokens[t]).transfer(sinks[s], amount);
    }
    _compareState();
  }

  function warp(uint256 secs) external {
    vm.warp(block.timestamp + (secs % 3 == 0 ? bound(secs, 90 days, 400 days) : bound(secs, 1 hours, 45 days)));
    _compareState();
  }

  function checkIn(uint256 seed) external {
    if (seed % 4 != 0) return; // rare, so deadlines are reached
    bool[2] memory ok;
    for (uint256 s; s < 2; ++s) {
      try this.routerCall(s, abi.encodeCall(TransferEOALegacy.activeAlive, (owners[s]))) {
        ok[s] = true;
      } catch {}
    }
    if (ok[0] != ok[1]) _fail("check-in accepted by one twin only");
    _compareState();
  }

  function setDistributions(uint256 seed) external {
    if (seed % 4 != 0) return;
    // Since round 8 v3 accepts in whole-estate mode exactly what wave A
    // accepts, a first line overlapping the second or third included.
    bool[2] memory ok;
    for (uint256 s; s < 2; ++s) {
      try this.routerCall(s, abi.encodeCall(TransferEOALegacy.setLegacyDistributions, (owners[s], _distSet(s, seed / 4)))) {
        ok[s] = true;
      } catch {}
    }
    if (ok[0] != ok[1]) _fail("first-line edit accepted by one twin only");
    _compareState();
  }

  function setLayers(uint256 seed) external {
    if (seed % 4 != 0) return;
    uint256 k = (seed / 4) % 4;
    bool[2] memory ok;
    for (uint256 s; s < 2; ++s) {
      (uint256 d2, uint256 d3, address l2, address l3) = k == 0
        ? (uint256(180 days), uint256(90 days), people[s][4], people[s][5])
        : k == 1
          ? (uint256(30 days), uint256(0), people[s][5], address(0))
          : k == 2
            ? (uint256(0), uint256(0), address(0), address(0))
            : (uint256(60 days), uint256(60 days), people[s][4], people[s][0]); // the third line on the first: refused
      bytes memory data = abi.encodeCall(
        TransferEOALegacy.setDelayAndLayer23Distributions,
        (owners[s], d2, d3, _dist(l2, l2 == address(0) ? 0 : MAX_PERCENT), _dist(l3, l3 == address(0) ? 0 : MAX_PERCENT))
      );
      try this.routerCall(s, data) {
        ok[s] = true;
      } catch {}
    }
    if (ok[0] != ok[1]) _fail("layer edit accepted by one twin only");
    _compareState();
  }

  /// @dev The router's combined setters on both twins, child calls in the
  /// router's order, each twin reverting as a whole: the second and third
  /// lines swapped, and `setLegacyConfig` moving the second line into the
  /// first line while naming a new second line.
  function combined(uint256 seed) external {
    bool[2] memory ok;
    for (uint256 s; s < 2; ++s) {
      (, address l2, address l3) = _legacy(s).getLegacyBeneficiaries();
      bytes[] memory calls;
      if (seed % 2 == 0) {
        calls = new bytes[](2);
        calls[0] = abi.encodeCall(TransferEOALegacy.setLayer23Distributions, (owners[s], uint8(2), _dist(l3, MAX_PERCENT)));
        calls[1] = abi.encodeCall(TransferEOALegacy.setLayer23Distributions, (owners[s], uint8(3), _dist(l2, MAX_PERCENT)));
      } else {
        address x = l2 != address(0) ? l2 : people[s][1];
        TransferLegacyStruct.Distribution[] memory d = new TransferLegacyStruct.Distribution[](2);
        (d[0], d[1]) = (_dist(people[s][0], 500_000), _dist(x, 500_000));
        address newL2 = x == people[s][4] ? people[s][3] : people[s][4];
        calls = new bytes[](3);
        calls[0] = abi.encodeCall(TransferEOALegacy.setLegacyDistributions, (owners[s], d));
        calls[1] = abi.encodeCall(TransferEOALegacy.setActivationTrigger, (owners[s], TRIGGER));
        calls[2] = abi.encodeCall(
          TransferEOALegacy.setDelayAndLayer23Distributions,
          (owners[s], uint256(180 days), uint256(90 days), _dist(newL2, MAX_PERCENT), _dist(people[s][5], MAX_PERCENT))
        );
      }
      try this.routerMulti(s, calls) {
        ok[s] = true;
      } catch {}
    }
    ++combinedCompared;
    if (ok[0]) ++combinedAccepted;
    if (ok[0] != ok[1]) _fail("combined edit accepted by one twin only");
    _compareState();
  }

  function routerMulti(uint256 s, bytes[] calldata calls) external {
    require(msg.sender == address(this));
    for (uint256 i; i < calls.length; ++i) this.routerCall(s, calls[i]);
  }

  function claim(uint256 who, uint256 mask, bool withEth) external {
    uint256 i = who % 6;
    uint256 n;
    for (uint256 t; t < 3; ++t) if (mask & (1 << t) != 0) ++n;
    address[] memory assets = new address[](n);
    uint256 j;
    for (uint256 t; t < 3; ++t) if (mask & (1 << t) != 0) assets[j++] = tokens[t];
    bool[2] memory ok;
    for (uint256 s; s < 2; ++s) {
      try this.routerClaim(s, people[s][i], assets, withEth) {
        ok[s] = true;
      } catch {}
    }
    ++claimsCompared;
    if (ok[0]) ++claimsAccepted;
    if (ok[0] != ok[1]) _fail("claim accepted by one twin only");
    _compareState();
  }

  function routerCall(uint256 s, bytes calldata data) external {
    require(msg.sender == address(this));
    (bool ok, bytes memory ret) = address(_legacy(s)).call(data);
    if (!ok) {
      assembly {
        revert(add(ret, 32), mload(ret))
      }
    }
  }

  function routerClaim(uint256 s, address actor, address[] calldata assets, bool withEth) external {
    require(msg.sender == address(this));
    TransferEOALegacy l = _legacy(s);
    if (!withEth && assets.length == 0) revert("NumAssetsInvalid");
    l.activeLegacy(assets, withEth, actor);
    uint8 beneLayer = l.getBeneficiaryLayer(actor);
    if (beneLayer > l.getLayer()) revert("CannotClaim");
    if (beneLayer == 0) revert("OnlyBeneficaries");
  }
}

contract LegacyV3WholeEstateDiff is Test {
  WholeEstateHandler internal h;

  function setUp() public {
    h = new WholeEstateHandler();
    h.boot();
    targetContract(address(h));
    bytes4[] memory s = new bytes4[](9);
    s[8] = h.combined.selector;
    s[0] = h.deposit.selector;
    s[1] = h.drain.selector;
    s[2] = h.warp.selector;
    s[3] = h.checkIn.selector;
    s[4] = h.setDistributions.selector;
    s[5] = h.setLayers.selector;
    s[6] = h.claim.selector;
    s[7] = h.claim.selector;
    targetSelector(FuzzSelector({addr: address(h), selectors: s}));
  }

  /// @dev V9: whole-estate v3 is the wave A clone, call for call.
  function invariant_wholeEstateIsWaveA() public view {
    assertEq(h.violations(), 0, h.lastViolation());
  }

  function afterInvariant() public {
    string memory path = vm.envOr("FUZZ_SUMMARY", string(""));
    if (bytes(path).length == 0) return;
    vm.createDir("out", true);
    if (!vm.exists(path)) vm.writeFile(path, "");
    vm.writeLine(path, string.concat("v3.diff.claim ", vm.toString(h.claimsCompared()), " ", vm.toString(h.claimsAccepted())));
    vm.writeLine(path, string.concat("v3.diff.combined ", vm.toString(h.combinedCompared()), " ", vm.toString(h.combinedAccepted())));
  }
}
