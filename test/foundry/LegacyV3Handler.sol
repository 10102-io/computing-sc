// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {TransferEOALegacyV3} from "../../contracts/forwarding/TransferLegacyEOAContractV3.sol";
import {TransferLegacyStruct} from "../../contracts/libraries/TransferLegacyStruct.sol";
import {ERC20Token} from "../../contracts/mock/ERC20Token.sol";
import {MockNoReturnERC20} from "../../contracts/mock/MockNoReturnERC20.sol";
import {MockAwkwardERC20} from "../../contracts/mock/MockAwkwardERC20.sol";
import {MockERC721} from "../../contracts/mock/ERC721Token.sol";
import {MockERC1155} from "../../contracts/mock/ERC1155Token.sol";
import {MockPermit2} from "../../contracts/mock/MockPermit2.sol";
import {LegacyV3Base} from "./LegacyV3Base.sol";

interface IHostileHook {
  function hostileOwner() external;
}

/// @dev A first-line heir (carol) whose transfer callbacks have the owner try
/// to delete, withdraw from, check in on and edit the legacy (an owner that
/// is a contract or an EIP-7702 account colluding with the heir). Every
/// attempt must fail; the handler counts any that does not.
contract HostileHeir {
  IHostileHook internal immutable hook;

  constructor(address hook_) {
    hook = IHostileHook(hook_);
  }

  function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
    hook.hostileOwner();
    return this.onERC721Received.selector;
  }

  function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4) {
    hook.hostileOwner();
    return this.onERC1155Received.selector;
  }

  receive() external payable {
    hook.hostileOwner();
  }
}

/**
 * @dev Stateful handler for the TransferEOALegacyV3 invariant suite. One
 * legacy, created as the router creates it, with three first-line shares,
 * backup lines, a second and a third line, an executor, three tokens on the
 * three pull rails (a direct allowance, a no-return token on a direct
 * allowance, Permit2 through LegacyPullVaultV2, with a token that can
 * blocklist Payment), ETH (Payment can refuse it), and ERC-721 and ERC-1155
 * items. This contract is the router: claims go through
 * `routerClaim`, which runs the router's own checks after the clone call,
 * so a refused claim reverts as a whole, as on chain.
 *
 * Every entry point computes what MUST happen from a model of the spec kept
 * here (the deadline with the executor's attestation, layers, backup windows,
 * per-share dues, NFT payees, every setter's acceptance rule), calls the
 * contract, and compares acceptance and every balance and record it can
 * see. A mismatch is recorded in `violations`, never thrown, so
 * `fail_on_revert` stays on for the harness itself.
 */
contract LegacyV3Handler is LegacyV3Base {
  uint256 internal constant DELAY2_DEFAULT = 180 days;
  uint256 internal constant DELAY3_DEFAULT = 90 days;

  TransferEOALegacyV3 public legacy;
  address public owner;
  address public alice;
  address public bob;
  address public carol;
  address public dave;
  address public alice2;
  address public alice3;
  address public bob2;
  address public carol2;
  address public sam;
  address public tina;
  address public exe;
  address public eve;
  address public sink;
  address public funder;
  address public newL2; // the second line named by the combined cross-line move
  address[] public actors;
  address[] public everShares;
  mapping(address => bool) internal isEverShare;

  ERC20Token internal tokA;
  MockNoReturnERC20 internal tokB;
  MockAwkwardERC20 internal tokC;
  address[] public tokens;
  MockERC721 public nft721;
  MockERC721 public unlisted721;
  MockERC1155 public nft1155;

  // ───────────── model of the spec ─────────────

  uint256 public mLast;
  uint256 public mAttested;
  address public mExecutor;
  uint64 public mBackupDelay;
  bool public mActivated;
  uint256 public mDelay2;
  uint256 public mDelay3;
  address public mL2;
  address public mL3;
  address[] internal mShares;
  mapping(address => uint256) public mPct;
  mapping(address => address[2]) internal mLines;
  mapping(address => address) public mPrimaryOf;
  address[] internal mBackups;
  TransferEOALegacyV3.NftItem[] internal mItems;
  uint256[] internal mMoved;
  mapping(address => address) public mShareOwner;
  mapping(address => mapping(address => uint256)) public mReleased;
  mapping(address => uint256) public mTotal;
  bool public mFeeRefused; // tokC blocklists Payment and Payment refuses ETH

  // ───────────── ghosts for the invariant contract ─────────────

  mapping(address => uint256) public ghostIn; // token (address(0) = ETH) => everything ever made available
  mapping(address => uint256) public ghostClaimedOut; // token => everything claims moved out (net + collected fee)
  /// @dev Per-share fees that could not reach Payment. They stay in the
  /// owner's wallet (or the legacy, for ETH) and are still counted as
  /// released, so the records may exceed inflows by this much (K-13).
  mapping(address => uint256) public ghostFeeUncollected;
  uint256 public feesRefused; // claims whose fee could not reach Payment
  uint256 public ghost1155Minted0;
  uint256 public ghost1155Minted1;
  uint256 public perShareClaims;
  uint256 public sweepClaims;
  uint256 public backupClaims;
  uint256 public cappedClaims;
  uint256 public nftMoves;
  /// @dev Observed, not modelled: the first address each share paid (tokens,
  /// ETH or an NFT unit) in per-share mode. Every later payment from the
  /// share must go to it.
  mapping(address => address) public ghostFirstPayee;
  uint256 public ownedRefused; // first-line claims refused because someone else owns the share
  uint256 public ownedSkipped; // sweeps that left a share someone else owns untouched
  uint256 public ownersSet; // shares that got their first payee
  uint256 public hostileAttempts; // owner calls tried from inside a transfer callback
  uint256 public combinedEdits; // accepted router combined setters (cross-line move, layer swap)

  bool public ownerDead;

  uint256 public violations;
  string public lastViolation;
  mapping(string => uint256) public calls;
  mapping(string => uint256) public accepted;
  string[] internal opNames;
  mapping(string => bool) internal opSeen;

  constructor() {
    _deployStack();
    owner = makeAddr("owner");
    alice = makeAddr("alice");
    bob = makeAddr("bob");
    carol = address(new HostileHeir(address(this)));
    newL2 = makeAddr("newL2");
    dave = makeAddr("dave");
    alice2 = makeAddr("alice2");
    alice3 = makeAddr("alice3");
    bob2 = makeAddr("bob2");
    carol2 = makeAddr("carol2");
    sam = makeAddr("sam");
    tina = makeAddr("tina");
    exe = makeAddr("executor");
    eve = makeAddr("eve");
    sink = makeAddr("sink");
    funder = makeAddr("funder");
    address[14] memory a = [alice, bob, carol, dave, alice2, alice3, bob2, carol2, sam, tina, exe, eve, owner, newL2];
    for (uint256 i; i < a.length; ++i) actors.push(a[i]);

    tokA = new ERC20Token("Token A", "A", 18);
    tokB = new MockNoReturnERC20("Tether-like", "B", 6);
    tokC = new MockAwkwardERC20();
    tokens.push(address(tokA));
    tokens.push(address(tokB));
    tokens.push(address(tokC));
    nft721 = new MockERC721();
    unlisted721 = new MockERC721();
    nft1155 = new MockERC1155();
    allowlist.addCollection(address(nft721));
    allowlist.addCollection(address(nft1155));
    nft721.mint(owner, 3); // ids 0, 1, 2
    unlisted721.mint(owner, 1); // id 0
    nft1155.mint(owner, 10); // id 0 x10
    nft1155.mint(owner, 5); // id 1 x5
    ghost1155Minted0 = 10;
    ghost1155Minted1 = 5;
  }

  /// @dev Creates the legacy once this contract has code: the clone's
  /// initializer reads `pullVault()` from its router, as on chain.
  function boot() external {
    require(address(legacy) == address(0));
    legacy = TransferEOALegacyV3(payable(_create(address(v3Impl), 1, owner, _distSet(0), DELAY2_DEFAULT, DELAY3_DEFAULT, sam, tina)));
    mLast = block.timestamp;
    mDelay2 = DELAY2_DEFAULT;
    mDelay3 = DELAY3_DEFAULT;
    mL2 = sam;
    mL3 = tina;
    _setModelShares(_distSet(0));

    vm.startPrank(owner);
    tokA.approve(address(legacy), type(uint256).max);
    tokB.approve(address(legacy), type(uint256).max);
    tokC.approve(PERMIT2, type(uint256).max);
    MockPermit2(PERMIT2).approve(address(tokC), address(vault), type(uint160).max, type(uint48).max);
    nft721.setApprovalForAll(address(vault), true);
    nft1155.setApprovalForAll(address(legacy), true);
    vm.stopPrank();

    _mint(0, 1_000e18);
    _mint(1, 1_000e6);
    _mint(2, 500e18);
    vm.deal(funder, 10 ether);
    vm.prank(funder);
    (bool sent, ) = address(legacy).call{value: 10 ether}("");
    require(sent);
    ghostIn[address(0)] += 10 ether;

    vm.prank(owner);
    legacy.setExecutor(exe);
    mExecutor = exe;
    (uint64 delay, TransferEOALegacyV3.BackupLine[] memory lines) = _lineSet(0);
    vm.prank(owner);
    legacy.setBackupLines(delay, lines);
    _applyLines(delay, lines);
    TransferEOALegacyV3.NftItem[] memory items = _itemSet(0x0f);
    vm.prank(owner);
    legacy.setNftItems(items);
    _applyItems(items);
  }

  // ───────────── fixed option sets ─────────────

  function _distSet(uint256 k) internal view returns (TransferLegacyStruct.Distribution[] memory d) {
    k %= 7;
    if (k == 5) {
      // A repeated address: the router and wave A accept it, v3 must not.
      d = new TransferLegacyStruct.Distribution[](3);
      (d[0], d[1], d[2]) = (_dist(alice, 300_000), _dist(bob, 400_000), _dist(alice, 300_000));
      return d;
    }
    if (k == 6) {
      // The second-line beneficiary on the first line: refused while sam is on another line.
      d = new TransferLegacyStruct.Distribution[](2);
      (d[0], d[1]) = (_dist(alice, 500_000), _dist(sam, 500_000));
      return d;
    }
    if (k == 0) {
      d = new TransferLegacyStruct.Distribution[](3);
      (d[0], d[1], d[2]) = (_dist(alice, 500_000), _dist(bob, 300_000), _dist(carol, 200_000));
    } else if (k == 1) {
      d = new TransferLegacyStruct.Distribution[](2);
      (d[0], d[1]) = (_dist(alice, 600_000), _dist(bob, 400_000));
    } else if (k == 2) {
      d = new TransferLegacyStruct.Distribution[](3);
      (d[0], d[1], d[2]) = (_dist(carol, 333_333), _dist(dave, 333_333), _dist(alice, 333_334));
    } else if (k == 3) {
      d = new TransferLegacyStruct.Distribution[](1);
      d[0] = _dist(bob, MAX_PERCENT);
    } else {
      // Names the executor: refused while it is the executor.
      d = new TransferLegacyStruct.Distribution[](2);
      (d[0], d[1]) = (_dist(alice, 500_000), _dist(exe, 500_000));
    }
  }

  function _line(address p, address s, address t) internal pure returns (TransferEOALegacyV3.BackupLine memory) {
    return TransferEOALegacyV3.BackupLine({primary: p, second: s, third: t});
  }

  function _lineSet(uint256 k) internal view returns (uint64 delay, TransferEOALegacyV3.BackupLine[] memory l) {
    k %= 13;
    if (k == 0) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](2);
      (l[0], l[1]) = (_line(alice, alice2, alice3), _line(bob, bob2, address(0)));
    } else if (k == 1) {
      delay = 30 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(carol, carol2, address(0));
    } else if (k == 2) {
      delay = 90 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, bob2, address(0));
    } else if (k == 3) {
      delay = 0; // per-share mode off
    } else if (k == 4) {
      delay = 60 days; // per-share mode with no backups at all
    } else if (k == 5) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, alice2, alice2); // second == third
    } else if (k == 6) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(dave, alice2, address(0)); // valid only while dave is first line
    } else if (k == 7) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, bob, address(0)); // a backup on the first line
    } else if (k == 8) {
      delay = 100 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, alice2, address(0)); // opens after the second line
    } else if (k == 9) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, exe, address(0)); // the executor as a backup
    } else if (k == 10) {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](2);
      (l[0], l[1]) = (_line(alice, alice2, address(0)), _line(bob, alice2, address(0))); // one backup on two lines
    } else if (k == 11) {
      delay = 20 days; // below the minimum
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, alice2, address(0));
    } else {
      delay = 60 days;
      l = new TransferEOALegacyV3.BackupLine[](1);
      l[0] = _line(alice, sam, address(0)); // the second-line beneficiary as a backup
    }
  }

  function _item(address c, uint8 kind, uint256 id, uint256 amount, address b) internal pure returns (TransferEOALegacyV3.NftItem memory) {
    return TransferEOALegacyV3.NftItem({collection: c, kind: kind, tokenId: id, amount: amount, beneficiary: b});
  }

  /// @dev Templates 0-4 are valid under the starting first line; 5-9 are not.
  function _itemTemplate(uint256 t) internal view returns (TransferEOALegacyV3.NftItem memory) {
    if (t == 0) return _item(address(nft721), 1, 0, 1, alice);
    if (t == 1) return _item(address(nft721), 1, 1, 1, bob);
    if (t == 2) return _item(address(nft1155), 2, 0, 7, carol);
    if (t == 3) return _item(address(nft1155), 2, 1, 5, alice);
    if (t == 4) return _item(address(nft721), 1, 2, 1, carol);
    if (t == 5) return _item(address(nft721), 2, 0, 1, alice); // wrong kind
    if (t == 6) return _item(address(nft1155), 2, 0, 0, alice); // zero amount
    if (t == 7) return _item(address(nft721), 1, 0, 2, alice); // ERC-721 amount 2
    if (t == 8) return _item(address(unlisted721), 1, 0, 1, alice); // not on the list
    return _item(address(nft721), 1, 0, 1, sam); // not a first-line beneficiary
  }

  function _itemSet(uint256 mask) internal view returns (TransferEOALegacyV3.NftItem[] memory items) {
    uint256 n;
    for (uint256 t; t < 10; ++t) if (mask & (1 << t) != 0) ++n;
    items = new TransferEOALegacyV3.NftItem[](n);
    uint256 j;
    for (uint256 t; t < 10; ++t) if (mask & (1 << t) != 0) items[j++] = _itemTemplate(t);
  }

  // ───────────── model helpers ─────────────

  function _mLive() internal view returns (bool) {
    return !mActivated;
  }

  function _mDeadline() internal view returns (uint256) {
    uint256 base = mLast + TRIGGER;
    if (mAttested > mLast && mAttested + GRACE < base) return mAttested + GRACE;
    return base;
  }

  function _mCurrentLayer() internal view returns (uint8) {
    uint256 base = _mDeadline();
    if (mDelay3 != 0 && block.timestamp >= base + mDelay2 + mDelay3) return 3;
    if (mDelay2 != 0 && block.timestamp >= base + mDelay2) return 2;
    return 1;
  }

  /// @dev The wave A clone's layer: first line by percentage, then the second and third lines.
  function _mBaseLayer(address x) internal view returns (uint8) {
    if (mPct[x] > 0) return 1;
    if (x != address(0) && x == mL2) return 2;
    if (x != address(0) && x == mL3) return 3;
    return 0;
  }

  /// @dev v3: backups count as first line.
  function _mLayer(address x) internal view returns (uint8) {
    uint8 l = _mBaseLayer(x);
    if (l == 0 && mPrimaryOf[x] != address(0)) return 1;
    return l;
  }

  function _mOnAnyLine(address x) internal view returns (bool) {
    return _mBaseLayer(x) != 0 || mPrimaryOf[x] != address(0);
  }

  function _mRank(address primary, address claimant) internal view returns (uint256) {
    if (claimant == primary) return 0;
    return mLines[primary][0] == claimant ? 1 : 2;
  }

  /// @dev As the wave A clone writes a first line: a repeated address is added
  /// once and keeps its last percentage.
  function _setModelShares(TransferLegacyStruct.Distribution[] memory d) internal {
    for (uint256 i; i < mShares.length; ++i) mPct[mShares[i]] = 0;
    delete mShares;
    for (uint256 i; i < d.length; ++i) {
      if (mPct[d[i].user] == 0) mShares.push(d[i].user);
      mPct[d[i].user] = d[i].percent;
      if (!isEverShare[d[i].user]) {
        isEverShare[d[i].user] = true;
        everShares.push(d[i].user);
      }
    }
  }

  function _clearLines() internal {
    for (uint256 i; i < mBackups.length; ++i) {
      address p = mPrimaryOf[mBackups[i]];
      delete mLines[p];
      mPrimaryOf[mBackups[i]] = address(0);
    }
    delete mBackups;
  }

  function _applyLines(uint64 delay, TransferEOALegacyV3.BackupLine[] memory l) internal {
    _clearLines();
    for (uint256 i; i < l.length; ++i) {
      mLines[l[i].primary] = [l[i].second, l[i].third];
      mPrimaryOf[l[i].second] = l[i].primary;
      mBackups.push(l[i].second);
      if (l[i].third != address(0)) {
        mPrimaryOf[l[i].third] = l[i].primary;
        mBackups.push(l[i].third);
      }
    }
    mBackupDelay = delay;
  }

  function _applyItems(TransferEOALegacyV3.NftItem[] memory items) internal {
    delete mItems;
    delete mMoved;
    for (uint256 i; i < items.length; ++i) {
      mItems.push(items[i]);
      mMoved.push(0);
    }
  }

  function _linesAccepted(uint64 delay, TransferEOALegacyV3.BackupLine[] memory l) internal view returns (bool) {
    if (!_mLive()) return false;
    if (delay == 0) return l.length == 0;
    if (delay < 30 days || delay > 3650 days) return false;
    address[] memory seen = new address[](l.length * 3);
    uint256 n;
    for (uint256 i; i < l.length; ++i) {
      if (mPct[l[i].primary] == 0) return false;
      for (uint256 j; j < i; ++j) if (l[j].primary == l[i].primary) return false;
      if (l[i].second == address(0) || l[i].second == l[i].third) return false;
      address[2] memory bs = [l[i].second, l[i].third];
      for (uint256 b; b < 2; ++b) {
        address x = bs[b];
        if (x == address(0)) continue;
        if (x == owner || x == mExecutor || _mBaseLayer(x) != 0) return false;
        for (uint256 k; k < n; ++k) if (seen[k] == x) return false;
        seen[n++] = x;
      }
    }
    if (mDelay2 != 0 && mDelay2 < 2 * uint256(delay)) return false;
    // Entering per-share mode: nothing may strand. No first-line primary on the
    // second or third line, and the first line sums to 100%.
    if ((mL2 != address(0) && mPct[mL2] != 0) || (mL3 != address(0) && mPct[mL3] != 0)) return false;
    uint256 sum;
    for (uint256 i; i < mShares.length; ++i) sum += mPct[mShares[i]];
    return sum == MAX_PERCENT;
  }

  function _itemsAccepted(TransferEOALegacyV3.NftItem[] memory items) internal view returns (bool) {
    if (!_mLive() || items.length > 50) return false;
    for (uint256 i; i < items.length; ++i) {
      TransferEOALegacyV3.NftItem memory it = items[i];
      uint8 kind = it.collection == address(nft721) ? 1 : it.collection == address(nft1155) ? 2 : 0;
      if (kind == 0 || it.kind != kind) return false;
      if (kind == 1 ? it.amount != 1 : it.amount == 0) return false;
      if (mPct[it.beneficiary] == 0) return false;
    }
    return true;
  }

  // ───────────── bookkeeping ─────────────

  function _op(string memory name) internal {
    if (!opSeen[name]) {
      opSeen[name] = true;
      opNames.push(name);
    }
    calls[name] += 1;
  }

  function _ok(string memory name) internal {
    accepted[name] += 1;
  }

  function _fail(string memory why) internal {
    violations += 1;
    lastViolation = why;
  }

  function _check(bool cond, string memory why) internal {
    if (!cond) _fail(why);
  }

  function writeSummary(string memory path) external {
    for (uint256 i; i < opNames.length; ++i) {
      vm.writeLine(path, string.concat(opNames[i], " ", vm.toString(calls[opNames[i]]), " ", vm.toString(accepted[opNames[i]])));
    }
    // Reach: how often the states that matter were hit (count twice to keep the three-column format).
    string[11] memory names = [
      "v3.reach.perShareClaim",
      "v3.reach.sweepClaim",
      "v3.reach.backupClaim",
      "v3.reach.cappedDue",
      "v3.reach.nftMove",
      "v3.reach.shareOwned",
      "v3.reach.ownedRefused",
      "v3.reach.ownedSkipped",
      "v3.reach.hostileOwnerCall",
      "v3.reach.combinedEdit",
      "v3.reach.feeRefused"
    ];
    uint256[11] memory counts = [
      perShareClaims,
      sweepClaims,
      backupClaims,
      cappedClaims,
      nftMoves,
      ownersSet,
      ownedRefused,
      ownedSkipped,
      hostileAttempts,
      combinedEdits,
      feesRefused
    ];
    for (uint256 i; i < 11; ++i) vm.writeLine(path, string.concat(names[i], " ", vm.toString(counts[i]), " ", vm.toString(counts[i])));
  }

  function _mint(uint256 t, uint256 amount) internal {
    if (t == 0) tokA.mint(owner, amount);
    else if (t == 1) tokB.mint(owner, amount);
    else tokC.mint(owner, amount);
    ghostIn[tokens[t]] += amount;
  }

  function _bal(address token, address who) internal view returns (uint256) {
    return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
  }

  // ───────────── owner, inflows and time ─────────────

  function deposit(uint256 tSeed, uint256 amount) external {
    _op("v3.deposit");
    uint256 t = tSeed % 4;
    if (t == 3) {
      amount = bound(amount, 1, 5 ether);
      bool fromOwner = tSeed % 8 >= 4 && !ownerDead;
      address from = fromOwner ? owner : funder;
      vm.deal(from, from.balance + amount);
      vm.prank(from);
      (bool sent, ) = address(legacy).call{value: amount}("");
      _check(sent, "the legacy refused ETH");
      ghostIn[address(0)] += amount;
      // The owner's ETH is a sign of life while the legacy is live.
      if (sent && fromOwner && _mLive()) mLast = block.timestamp;
    } else {
      amount = bound(amount, 1, t == 1 ? 1e15 : 1e27);
      _mint(t, amount);
    }
    _ok("v3.deposit");
  }

  /// @dev The owner's wallet shrinks outside the legacy (spending, another
  /// approval, a drainer); for ETH, the owner withdraws from a live legacy.
  function drain(uint256 tSeed, uint256 amount) external {
    _op("v3.drain");
    uint256 t = tSeed % 4;
    if (t == 3) {
      uint256 bal = address(legacy).balance;
      if (bal == 0 || ownerDead) return;
      amount = bound(amount, 1, bal);
      bool expect = _mLive();
      try this.routerWithdraw(amount) {
        _check(expect, "withdraw accepted on a legacy that is not live");
        mLast = block.timestamp;
        ghostIn[address(0)] -= amount;
        _ok("v3.drain");
      } catch {
        _check(!expect, "withdraw refused on a live legacy");
      }
      return;
    }
    address token = tokens[t];
    uint256 have = IERC20(token).balanceOf(owner);
    if (have == 0) return;
    amount = bound(amount, 1, have);
    vm.prank(owner);
    if (t == 1) tokB.transfer(sink, amount);
    else IERC20(token).transfer(sink, amount);
    _ok("v3.drain");
  }

  function routerWithdraw(uint256 amount) external {
    require(msg.sender == address(this));
    legacy.withdraw(owner, amount);
  }

  /// @dev Short steps (to land inside backup windows and line periods) or
  /// long ones (to reach a deadline in one go).
  function warp(uint256 secs) external {
    _op("v3.warp");
    vm.warp(block.timestamp + (secs % 3 == 0 ? bound(secs, 90 days, 400 days) : bound(secs, 1 hours, 45 days)));
    _ok("v3.warp");
  }

  /// @dev From here on the owner never acts again: no check-in, setting,
  /// withdrawal or ETH of theirs. Third parties may still drain the wallet.
  function die(uint256 seed) external {
    _op("v3.die");
    // Rare enough that most runs see owner edits first; some runs never die
    // and reach claims only through silence or an attestation.
    if (seed % 5 != 0) return;
    ownerDead = true;
    _ok("v3.die");
  }

  /// @dev Fees that cannot reach Payment: the vault-rail token blocklists it
  /// and Payment refuses ETH, or both are switched back. A claim must still
  /// pay its due minus the fee; the fee is not collected.
  function feeRefusal(uint256 seed) external {
    _op("v3.feeRefusal");
    bool refuse = seed % 2 == 1;
    tokC.setBlocked(address(payment), refuse);
    payment.setRefuseEth(refuse);
    mFeeRefused = refuse;
    _ok("v3.feeRefusal");
  }

  function _feeRefused(address token) internal view returns (bool) {
    return mFeeRefused && (token == address(0) || token == address(tokC));
  }

  function checkIn() external {
    if (ownerDead) return;
    _op("v3.checkIn");
    bool expect = _mLive();
    try this.routerCheckIn() {
      _check(expect, "check-in accepted on a legacy that is not live");
      mLast = block.timestamp;
      _ok("v3.checkIn");
    } catch {
      _check(!expect, "check-in refused on a live legacy");
    }
  }

  function routerCheckIn() external {
    require(msg.sender == address(this));
    legacy.activeAlive(owner);
  }

  function setLines(uint256 seed) external {
    if (ownerDead) return;
    _op("v3.setLines");
    // Half the time one of the valid per-share sets, otherwise any set.
    uint256[4] memory on = [uint256(0), 1, 2, 4];
    (uint64 delay, TransferEOALegacyV3.BackupLine[] memory l) = _lineSet(seed % 2 == 0 ? on[(seed / 2) % 4] : seed / 2);
    bool expect = _linesAccepted(delay, l);
    vm.prank(owner);
    try legacy.setBackupLines(delay, l) {
      _check(expect, "setBackupLines accepted against the spec");
      _applyLines(delay, l);
      mLast = block.timestamp;
      _ok("v3.setLines");
    } catch {
      _check(!expect, "setBackupLines refused against the spec");
    }
  }

  function setItems(uint256 mask) external {
    if (ownerDead) return;
    _op("v3.setItems");
    if (mask % 2 == 0) {
      // Half the time only valid templates for the current first line.
      uint256 valid;
      for (uint256 t; t < 5; ++t) if ((mask >> 1) & (1 << t) != 0 && mPct[_itemTemplate(t).beneficiary] > 0) valid |= 1 << t;
      mask = valid;
    } else {
      mask = (mask >> 1) % 1024;
    }
    TransferEOALegacyV3.NftItem[] memory items = _itemSet(mask);
    bool expect = _itemsAccepted(items);
    vm.prank(owner);
    try legacy.setNftItems(items) {
      _check(expect, "setNftItems accepted against the spec");
      _applyItems(items);
      mLast = block.timestamp;
      _ok("v3.setItems");
    } catch {
      _check(!expect, "setNftItems refused against the spec");
    }
  }

  function setDistributions(uint256 seed) external {
    // A first-line edit voids lines and items; keep it rarer than the others.
    if (ownerDead || seed % 3 != 0) return;
    seed /= 3;
    _op("v3.setDistributions");
    TransferLegacyStruct.Distribution[] memory d = _distSet(seed);
    // Round 8: a first-line edit leaves per-share mode, so v3 adds no check
    // of its own here; a repeated or cross-layer first line is accepted as
    // on wave A and only refused when entering per-share mode again.
    bool expect = _mLive();
    for (uint256 i; i < d.length; ++i) if (mExecutor != address(0) && d[i].user == mExecutor) expect = false;
    try this.routerSetDistributions(d) {
      _check(expect, "setLegacyDistributions accepted against the spec");
      _setModelShares(d);
      // A first-line change voids the backup lines and the NFT items.
      _clearLines();
      mBackupDelay = 0;
      delete mItems;
      delete mMoved;
      mLast = block.timestamp;
      _ok("v3.setDistributions");
    } catch {
      _check(!expect, "setLegacyDistributions refused against the spec");
    }
  }

  function routerSetDistributions(TransferLegacyStruct.Distribution[] calldata d) external {
    require(msg.sender == address(this));
    legacy.setLegacyDistributions(owner, d);
  }

  /// @dev Second and third lines and their delays, through the router.
  function setLayers(uint256 seed) external {
    if (ownerDead) return;
    _op("v3.setLayers");
    uint256 k = seed % 8;
    if (k == 7) {
      // The wave A clone's single-layer setter: tina as the second line, even
      // while she is the third. Round 8: allowed, one address then covers
      // both periods and nothing strands.
      bool ok2 = _mLive() &&
        mPct[tina] == 0 &&
        mDelay2 != 0 &&
        ((mDelay3 == 0 && mL3 == address(0)) || (mDelay3 != 0 && mL3 != address(0))) &&
        mExecutor != tina &&
        mPrimaryOf[tina] == address(0);
      try this.routerSetLayer2(tina) {
        _check(ok2, "setLayer23Distributions accepted against the spec");
        mL2 = tina;
        mLast = block.timestamp;
        _ok("v3.setLayers");
      } catch {
        _check(!ok2, "setLayer23Distributions refused against the spec");
      }
      return;
    }
    (uint256 d2, uint256 d3, address l2, address l3) = k == 0
      ? (DELAY2_DEFAULT, DELAY3_DEFAULT, sam, tina)
      : k == 1
        ? (DELAY2_DEFAULT, uint256(0), sam, address(0))
        : k == 2
          ? (uint256(0), uint256(0), address(0), address(0))
          : k == 3
            ? (120 days, uint256(0), sam, address(0))
            : k == 4
              ? (DELAY2_DEFAULT, DELAY3_DEFAULT, alice2, tina)
              : k == 5
                ? (DELAY2_DEFAULT, DELAY3_DEFAULT, exe, tina)
                : (DELAY2_DEFAULT, DELAY3_DEFAULT, sam, alice);
    bool expect = _mLive();
    if (l2 != address(0) && mPct[l2] != 0) expect = false;
    if (l3 != address(0) && (l3 == l2 || mPct[l3] != 0)) expect = false;
    if (l3 != address(0) && !(d2 != 0 && d3 != 0 && l2 != address(0))) expect = false;
    if (mExecutor != address(0) && (mExecutor == l2 || mExecutor == l3)) expect = false;
    if ((l2 != address(0) && mPrimaryOf[l2] != address(0)) || (l3 != address(0) && mPrimaryOf[l3] != address(0))) expect = false;
    if (mBackupDelay != 0 && d2 != 0 && d2 < 2 * uint256(mBackupDelay)) expect = false;
    try this.routerSetLayers(d2, d3, l2, l3) {
      _check(expect, "setDelayAndLayer23Distributions accepted against the spec");
      (mDelay2, mDelay3, mL2, mL3) = (d2, d3, l2, l3);
      mLast = block.timestamp;
      _ok("v3.setLayers");
    } catch {
      _check(!expect, "setDelayAndLayer23Distributions refused against the spec");
    }
  }

  function routerSetLayer2(address user) external {
    require(msg.sender == address(this));
    legacy.setLayer23Distributions(owner, 2, _dist(user, MAX_PERCENT));
  }

  /// @dev The router's combined setters, child calls in the router's order,
  /// reverting as a whole (round 8): `setBothLayer23Distributions` swapping
  /// the second and third lines, and `setLegacyConfig` moving the second
  /// line into the first line while naming a new second line.
  function combinedEdit(uint256 seed) external {
    if (ownerDead) return;
    _op("v3.combined");
    if (seed % 2 == 0) {
      (address l2, address l3) = (mL2, mL3);
      bool expect = _mLive() &&
        l2 != address(0) &&
        l3 != address(0) &&
        l2 != l3 &&
        mDelay2 != 0 &&
        mDelay3 != 0 &&
        mPct[l2] == 0 &&
        mPct[l3] == 0;
      try this.routerSwapLayers(l3, l2) {
        _check(expect, "setBothLayer23Distributions (swap) accepted against the spec");
        (mL2, mL3) = (l3, l2);
        mLast = block.timestamp;
        ++combinedEdits;
        _ok("v3.combined");
      } catch {
        _check(!expect, "setBothLayer23Distributions (swap) refused against the spec");
      }
      return;
    }
    address x = mL2 != address(0) && mL2 != alice ? mL2 : bob;
    TransferLegacyStruct.Distribution[] memory d = new TransferLegacyStruct.Distribution[](2);
    (d[0], d[1]) = (_dist(alice, 500_000), _dist(x, 500_000));
    uint256 d2 = mDelay2 != 0 ? mDelay2 : DELAY2_DEFAULT;
    address l3_ = mL3;
    uint256 d3 = l3_ != address(0) ? mDelay3 : 0;
    // Child 1 (first line) on the current state; child 3 (layers) on the
    // state after it: lines voided, first line {alice, x}.
    bool inD3 = l3_ == alice || l3_ == x;
    bool expectCfg = _mLive() &&
      x != newL2 && // after an earlier move the second line is newL2: it cannot be on both lines
      (mExecutor == address(0) || (mExecutor != alice && mExecutor != x && mExecutor != newL2 && mExecutor != l3_)) &&
      (l3_ == address(0) || (l3_ != newL2 && !inD3 && d2 != 0 && d3 != 0));
    try this.routerSetLegacyConfig(d, d2, d3, newL2, l3_) {
      _check(expectCfg, "setLegacyConfig (cross-line move) accepted against the spec");
      _setModelShares(d);
      _clearLines();
      mBackupDelay = 0;
      delete mItems;
      delete mMoved;
      (mDelay2, mDelay3, mL2, mL3) = (d2, d3, newL2, l3_);
      mLast = block.timestamp;
      ++combinedEdits;
      _ok("v3.combined");
    } catch {
      _check(!expectCfg, "setLegacyConfig (cross-line move) refused against the spec");
    }
  }

  function routerSwapLayers(address l2, address l3) external {
    require(msg.sender == address(this));
    // TransferEOALegacyRouter.setBothLayer23Distributions
    legacy.setLayer23Distributions(owner, 2, _dist(l2, MAX_PERCENT));
    legacy.setLayer23Distributions(owner, 3, _dist(l3, MAX_PERCENT));
  }

  function routerSetLegacyConfig(TransferLegacyStruct.Distribution[] calldata d, uint256 d2, uint256 d3, address l2, address l3) external {
    require(msg.sender == address(this));
    // TransferEOALegacyRouter.setLegacyConfig
    legacy.setLegacyDistributions(owner, d);
    legacy.setActivationTrigger(owner, TRIGGER);
    legacy.setDelayAndLayer23Distributions(owner, d2, d3, _dist(l2, l2 == address(0) ? 0 : MAX_PERCENT), _dist(l3, l3 == address(0) ? 0 : MAX_PERCENT));
  }

  /// @dev Called from carol's transfer callbacks (HostileHeir): the owner
  /// tries to delete, withdraw, check in and edit while a claim is moving
  /// value. The legacy is claimed before any transfer, so all must fail.
  function hostileOwner() external {
    ++hostileAttempts;
    bool got;
    try this.routerDelete() {
      got = true;
    } catch {}
    try this.routerWithdraw(1) {
      got = true;
    } catch {}
    try this.routerCheckIn() {
      got = true;
    } catch {}
    try this.routerSetDistributions(_distSet(0)) {
      got = true;
    } catch {}
    vm.prank(owner);
    try legacy.setExecutor(address(0)) {
      got = true;
    } catch {}
    if (got) _fail("the owner acted on the legacy from inside a transfer callback");
  }

  function routerDelete() external {
    require(msg.sender == address(this));
    legacy.deleteLegacy(owner);
  }

  function routerSetLayers(uint256 d2, uint256 d3, address l2, address l3) external {
    require(msg.sender == address(this));
    legacy.setDelayAndLayer23Distributions(
      owner,
      d2,
      d3,
      _dist(l2, l2 == address(0) ? 0 : MAX_PERCENT),
      _dist(l3, l3 == address(0) ? 0 : MAX_PERCENT)
    );
  }

  function setExecutor(uint256 seed) external {
    if (ownerDead) return;
    _op("v3.setExecutor");
    uint256 k = seed % 5;
    address x = k == 0 ? exe : k == 1 ? address(0) : k == 2 ? alice : k == 3 ? alice2 : owner;
    bool expect = _mLive() && (x == address(0) || (x != owner && !_mOnAnyLine(x)));
    vm.prank(owner);
    try legacy.setExecutor(x) {
      _check(expect, "setExecutor accepted against the spec");
      mExecutor = x;
      mAttested = 0;
      mLast = block.timestamp;
      _ok("v3.setExecutor");
    } catch {
      _check(!expect, "setExecutor refused against the spec");
    }
  }

  function attest(uint256 seed) external {
    _op("v3.attest");
    address who = seed % 4 == 0 ? actors[seed % actors.length] : exe;
    uint256 deadline = _mDeadline();
    bool expect = who == mExecutor &&
      _mLive() &&
      block.timestamp < deadline &&
      !_mOnAnyLine(who) &&
      block.timestamp >= mLast + TRIGGER / 2 &&
      (mAttested == 0 || block.timestamp >= mAttested + GRACE);
    vm.prank(who);
    try legacy.attestDeath() {
      _check(expect, "attestDeath accepted against the spec");
      mAttested = block.timestamp;
      _ok("v3.attest");
    } catch {
      _check(!expect, "attestDeath refused against the spec");
    }
    _check(legacy.deathAttestedAt() == mAttested, "deathAttestedAt differs from the model");
  }

  // ───────────── token and ETH claims ─────────────

  struct Exp {
    address[] recipients;
    uint256[] amounts; // per recipient, per asset slot (recipient-major)
    uint256 feeEth;
    uint256[3] feeTok;
  }

  function _assets(uint256 mask) internal view returns (address[] memory a) {
    uint256 n;
    for (uint256 t; t < 3; ++t) if (mask & (1 << t) != 0) ++n;
    a = new address[](n);
    uint256 j;
    for (uint256 t; t < 3; ++t) if (mask & (1 << t) != 0) a[j++] = tokens[t];
  }

  function _tokenIndex(address token) internal view returns (uint256) {
    for (uint256 t; t < 3; ++t) if (tokens[t] == token) return t;
    return 3;
  }

  /// @dev Two in three picks come from the people the spec lets claim (first
  /// line, backups, second and third lines); the rest from every actor.
  function _claimant(uint256 seed) internal view returns (address) {
    if (seed % 3 == 0) return actors[(seed / 3) % actors.length];
    address[] memory c = new address[](mShares.length + mBackups.length + 2);
    uint256 n;
    for (uint256 i; i < mShares.length; ++i) c[n++] = mShares[i];
    for (uint256 i; i < mBackups.length; ++i) c[n++] = mBackups[i];
    if (mL2 != address(0)) c[n++] = mL2;
    if (mL3 != address(0)) c[n++] = mL3;
    return c[(seed / 3) % n];
  }

  function claim(uint256 actorSeed, uint256 assetMask, bool withEth) external {
    _claim(actorSeed, assetMask, withEth);
  }

  /// @dev A second entry point, so claims are drawn as often as everything else together.
  function claimAgain(uint256 actorSeed, uint256 assetMask, bool withEth) external {
    _claim(actorSeed, assetMask, withEth);
  }

  function _claim(uint256 actorSeed, uint256 assetMask, bool withEth) internal {
    _op("v3.claim");
    address actor = _claimant(actorSeed);
    address[] memory assets = _assets(assetMask);

    bool expect = withEth || assets.length > 0;
    uint256 deadline = _mDeadline();
    uint8 layer = _mLayer(actor);
    if (block.timestamp < deadline || layer == 0 || layer > _mCurrentLayer()) expect = false;
    address only;
    bool early;
    bool owned;
    if (expect && mBackupDelay != 0 && layer == 1) {
      only = mPct[actor] > 0 ? actor : mPrimaryOf[actor];
      if (block.timestamp < deadline + _mRank(only, actor) * uint256(mBackupDelay)) {
        expect = false;
        early = true;
      } else if (mShareOwner[only] != address(0) && mShareOwner[only] != actor) {
        expect = false;
        owned = true;
      }
    }

    // Recipients whose balances the claim may change, and their balances now.
    address[] memory watch = new address[](everShares.length + mBackups.length + 4);
    uint256 nw;
    for (uint256 i; i < everShares.length; ++i) nw = _watch(watch, nw, everShares[i]);
    for (uint256 i; i < mBackups.length; ++i) nw = _watch(watch, nw, mBackups[i]);
    nw = _watch(watch, nw, sam);
    nw = _watch(watch, nw, tina);
    nw = _watch(watch, nw, address(payment));
    nw = _watch(watch, nw, actor);
    uint256[4] memory pre;
    pre[0] = address(legacy).balance;
    for (uint256 t; t < 3; ++t) pre[t + 1] = _pullable(tokens[t], owner, address(legacy));
    uint256[4][] memory before = new uint256[4][](nw);
    for (uint256 i; i < nw; ++i) {
      before[i][0] = watch[i].balance;
      for (uint256 t; t < 3; ++t) before[i][t + 1] = _bal(tokens[t], watch[i]);
    }
    uint256[4][] memory want = new uint256[4][](nw);

    address[] memory ownerBefore = new address[](mShares.length);
    uint256[4][] memory releasedBefore = new uint256[4][](mShares.length);
    for (uint256 i; i < mShares.length; ++i) {
      ownerBefore[i] = legacy.shareOwner(mShares[i]);
      releasedBefore[i][0] = legacy.released(address(0), mShares[i]);
      for (uint256 t; t < 3; ++t) releasedBefore[i][t + 1] = legacy.released(tokens[t], mShares[i]);
    }

    try this.routerClaim(actor, assets, withEth) {
      if (!expect) {
        _fail(
          early ? "a backup line claimed before its window" : owned ? "a first-line claim took a share someone else owns" : "claim accepted against the spec"
        );
        return;
      }
    } catch {
      _check(!expect, "claim refused against the spec");
      if (owned) ++ownedRefused;
      for (uint256 i; i < mShares.length; ++i) {
        _check(legacy.shareOwner(mShares[i]) == ownerBefore[i], "a refused claim changed ownership");
      }
      return;
    }
    _ok("v3.claim");
    mActivated = true;

    // What the spec says moved, computed on the model and the pre-call state.
    if (mBackupDelay != 0) {
      ++perShareClaims;
      if (layer == 1) {
        if (actor != only) ++backupClaims;
      } else {
        ++sweepClaims;
      }
      if (withEth) _expectSettle(address(0), pre[0], watch, nw, want, only, actor);
      for (uint256 i; i < assets.length; ++i) {
        _expectSettle(assets[i], pre[_tokenIndex(assets[i]) + 1], watch, nw, want, only, actor);
      }
    } else {
      if (withEth) _expectWhole(address(0), pre[0], watch, nw, want, layer, actor);
      for (uint256 i; i < assets.length; ++i) _expectWhole(assets[i], pre[_tokenIndex(assets[i]) + 1], watch, nw, want, layer, actor);
    }

    for (uint256 i; i < nw; ++i) {
      _check(watch[i].balance == before[i][0] + want[i][0], "ETH received differs from the spec");
      for (uint256 t; t < 3; ++t) {
        _check(_bal(tokens[t], watch[i]) == before[i][t + 1] + want[i][t + 1], "tokens received differ from the spec");
      }
    }
    _check(legacy.getIsActiveLegacy() == 2, "a claim did not activate the legacy");
    if (mBackupDelay != 0) {
      for (uint256 i; i < mShares.length; ++i) {
        address s = mShares[i];
        _check(legacy.shareOwner(s) == mShareOwner[s], "shareOwner differs from the model");
        // Observed payments: did this share pay anything in this claim?
        bool paid = legacy.released(address(0), s) != releasedBefore[i][0];
        for (uint256 t; t < 3; ++t) paid = paid || legacy.released(tokens[t], s) != releasedBefore[i][t + 1];
        if (paid) {
          _firstPayee(s, actor);
        } else {
          // An empty or failed payment changes no ownership.
          _check(legacy.shareOwner(s) == ownerBefore[i], "ownership changed without a payment");
          if (layer != 1 && ownerBefore[i] != address(0) && ownerBefore[i] != actor) ++ownedSkipped;
        }
        _check(legacy.released(address(0), s) == mReleased[address(0)][s], "released (ETH) differs from the model");
        for (uint256 t; t < 3; ++t) _check(legacy.released(tokens[t], s) == mReleased[tokens[t]][s], "released differs from the model");
      }
      _check(legacy.totalReleased(address(0)) == mTotal[address(0)], "totalReleased (ETH) differs from the model");
      for (uint256 t; t < 3; ++t) _check(legacy.totalReleased(tokens[t]) == mTotal[tokens[t]], "totalReleased differs from the model");
    }
  }

  function routerClaim(address actor, address[] calldata assets, bool withEth) external {
    require(msg.sender == address(this));
    // TransferEOALegacyRouter._runActiveLegacy, checks in the same order.
    if (!withEth && assets.length == 0) revert("NumAssetsInvalid");
    legacy.activeLegacy(assets, withEth, actor);
    uint8 beneLayer = legacy.getBeneficiaryLayer(actor);
    uint8 currentLayer = legacy.getLayer();
    if (beneLayer > currentLayer) revert("CannotClaim");
    if (beneLayer == 0) revert("OnlyBeneficaries");
  }

  /// @dev Records a payment from share `s` to `to`: the first one fixes the
  /// share's payee, every later one must go to the same address.
  function _firstPayee(address s, address to) internal {
    address first = ghostFirstPayee[s];
    if (first == address(0)) {
      ghostFirstPayee[s] = to;
      ++ownersSet;
    } else {
      _check(first == to, "a share paid a second address after its first payee");
    }
  }

  function _watch(address[] memory watch, uint256 nw, address who) internal pure returns (uint256) {
    for (uint256 i; i < nw; ++i) if (watch[i] == who) return nw;
    watch[nw] = who;
    return nw + 1;
  }

  function _slot(address[] memory watch, uint256 nw, address who) internal pure returns (uint256) {
    for (uint256 i; i < nw; ++i) if (watch[i] == who) return i;
    revert("unwatched recipient");
  }

  /// @dev Per-share settlement, written from the plan: each share in scope
  /// (the claimant's own share on the first line; on the second or third,
  /// every share nobody else owns) is due its percentage of everything ever
  /// made available minus what it received, filled in share order up to what
  /// is pullable (`available`, taken before the call; assets in one claim are
  /// distinct). A share that pays anything belongs to `to` from then on.
  function _expectSettle(
    address token,
    uint256 available,
    address[] memory watch,
    uint256 nw,
    uint256[4][] memory want,
    address only,
    address to
  ) internal {
    uint256 col = token == address(0) ? 0 : _tokenIndex(token) + 1;
    if (available == 0) return;
    uint256 pot = available + mTotal[token];
    uint256 amount;
    uint256[] memory due = new uint256[](mShares.length);
    for (uint256 i; i < mShares.length; ++i) {
      address s = mShares[i];
      address o = mShareOwner[s];
      if (only != address(0) ? s != only : o != address(0) && o != to) continue;
      uint256 entitled = (pot * mPct[s]) / MAX_PERCENT;
      uint256 got = mReleased[token][s];
      if (entitled <= got) continue;
      uint256 d = entitled - got;
      if (d > available - amount) {
        d = available - amount;
        ++cappedClaims;
      }
      due[i] = d;
      amount += d;
    }
    if (amount == 0) return;
    uint256 fee = _fee(amount);
    // A fee that cannot reach Payment is not collected, and still counted
    // as released (K-13): it stays in the pot.
    uint256 feeIn = _feeRefused(token) ? 0 : fee;
    want[_slot(watch, nw, to)][col] += amount - fee;
    want[_slot(watch, nw, address(payment))][col] += feeIn;
    for (uint256 i; i < mShares.length; ++i) {
      if (due[i] == 0) continue;
      mReleased[token][mShares[i]] += due[i];
      mShareOwner[mShares[i]] = to;
    }
    mTotal[token] += amount;
    ghostClaimedOut[token] += amount - fee + feeIn;
    if (feeIn != fee) {
      ghostFeeUncollected[token] += fee;
      ++feesRefused;
    }
  }

  /// @dev Whole-estate settlement, as the wave A clone pays: the fee first,
  /// then each recipient's percentage, the last one the remainder.
  function _expectWhole(
    address token,
    uint256 total,
    address[] memory watch,
    uint256 nw,
    uint256[4][] memory want,
    uint8 layer,
    address actor
  ) internal {
    uint256 col = token == address(0) ? 0 : _tokenIndex(token) + 1;
    if (total == 0) return;
    uint256 fee = _fee(total);
    uint256 distributable = total - fee;
    // A fee that cannot reach Payment stays where it was, not owed.
    uint256 feeIn = _feeRefused(token) ? 0 : fee;
    want[_slot(watch, nw, address(payment))][col] += feeIn;
    if (feeIn != fee) ++feesRefused;
    if (layer == 1) {
      uint256 processed;
      for (uint256 i; i < mShares.length; ++i) {
        uint256 a = i != mShares.length - 1 ? (distributable * mPct[mShares[i]]) / MAX_PERCENT : distributable - processed;
        want[_slot(watch, nw, mShares[i])][col] += a;
        processed += a;
      }
    } else {
      want[_slot(watch, nw, actor)][col] += distributable;
    }
    ghostClaimedOut[token] += distributable + feeIn;
  }

  // ───────────── NFT claims ─────────────

  function _nftPayee(address primary, uint8 layer, address actor) internal view returns (address) {
    if (mBackupDelay == 0) return layer == 1 ? primary : actor;
    address o = mShareOwner[primary];
    if (o != address(0) && o != actor) return address(0);
    if (layer != 1) return actor;
    if (actor != primary && mPrimaryOf[actor] != primary) return address(0);
    return block.timestamp >= _mDeadline() + _mRank(primary, actor) * uint256(mBackupDelay) ? actor : address(0);
  }

  function _viaVault(address collection) internal view returns (bool) {
    return MockERC721(collection).isApprovedForAll(owner, address(vault)) && vault.boundLegacy(owner) == address(legacy);
  }

  /// @dev Units that MUST move for an item, from who holds what and who may move it.
  function _units(TransferEOALegacyV3.NftItem memory it, uint256 left) internal view returns (uint256) {
    if (it.kind == 1) {
      if (MockERC721(it.collection).ownerOf(it.tokenId) != owner) return 0;
      if (_viaVault(it.collection)) return 1;
      bool direct = MockERC721(it.collection).isApprovedForAll(owner, address(legacy)) ||
        MockERC721(it.collection).getApproved(it.tokenId) == address(legacy);
      return direct ? 1 : 0;
    }
    uint256 have = MockERC1155(it.collection).balanceOf(owner, it.tokenId);
    uint256 n = have < left ? have : left;
    if (n == 0) return 0;
    if (_viaVault(it.collection) || MockERC1155(it.collection).isApprovedForAll(owner, address(legacy))) return n;
    return 0;
  }

  function claimNfts(uint256 actorSeed, uint256 indexMask) external {
    _op("v3.claimNfts");
    address actor = _claimant(actorSeed);
    uint256 len = mItems.length;
    uint256 n;
    for (uint256 k; k < len + 1; ++k) if (indexMask & (1 << k) != 0) ++n;
    uint256[] memory idx = new uint256[](n);
    uint256 j;
    for (uint256 k; k < len + 1; ++k) if (indexMask & (1 << k) != 0) idx[j++] = k;

    uint8 layer = _mLayer(actor);
    bool expect = block.timestamp >= _mDeadline() && layer != 0 && layer <= _mCurrentLayer();

    // Expected moves, item by item, on the pre-call state.
    address[] memory to = new address[](n);
    uint256[] memory units = new uint256[](n);
    uint256[] memory before = new uint256[](n);
    uint256 expectedMoves;
    for (uint256 k; k < n && expect; ++k) {
      if (idx[k] >= len) continue;
      TransferEOALegacyV3.NftItem memory it = mItems[idx[k]];
      uint256 left = it.amount - mMoved[idx[k]];
      address payee = _nftPayee(it.beneficiary, layer, actor);
      if (left == 0 || payee == address(0)) continue;
      to[k] = payee;
      units[k] = _units(it, left);
      if (units[k] > 0) ++expectedMoves;
      before[k] = it.kind == 1 ? 0 : MockERC1155(it.collection).balanceOf(payee, it.tokenId);
    }

    // Round 8: a call that would activate the legacy but moves nothing reverts.
    if (expect && !mActivated && expectedMoves == 0) expect = false;

    vm.prank(actor);
    try legacy.claimNfts(idx) returns (uint256 moved) {
      if (!expect) {
        _fail("claimNfts accepted against the spec");
        return;
      }
      _ok("v3.claimNfts");
      _check(moved == expectedMoves, "claimNfts moved a different number of items than the spec");
    } catch {
      _check(!expect, "claimNfts refused against the spec");
      return;
    }
    for (uint256 k; k < n; ++k) {
      if (units[k] == 0) continue;
      TransferEOALegacyV3.NftItem memory it = mItems[idx[k]];
      mMoved[idx[k]] += units[k];
      ++nftMoves;
      if (it.kind == 1) {
        _check(MockERC721(it.collection).ownerOf(it.tokenId) == to[k], "ERC-721 item went to the wrong address");
      } else {
        _check(MockERC1155(it.collection).balanceOf(to[k], it.tokenId) == before[k] + units[k], "ERC-1155 units differ from the spec");
      }
      if (mBackupDelay != 0) {
        mShareOwner[it.beneficiary] = to[k];
        _firstPayee(it.beneficiary, to[k]);
      }
      mActivated = true;
    }
    if (mBackupDelay != 0) {
      for (uint256 i; i < mShares.length; ++i) {
        _check(legacy.shareOwner(mShares[i]) == mShareOwner[mShares[i]], "shareOwner differs from the model after an NFT claim");
      }
    }
    for (uint256 i; i < len; ++i) {
      (, uint256 moved) = legacy.nftItem(i);
      _check(moved == mMoved[i], "units moved differ from the model");
    }
    _check(legacy.getIsActiveLegacy() == (mActivated ? 2 : 1), "activation differs from the model");
  }

  /// @dev The owner changes who may move the NFTs, or moves some away.
  function nftApprovals(uint256 seed) external {
    _op("v3.nftApprovals");
    uint256 k = seed % 8;
    if (ownerDead) k = 7; // only third parties act
    vm.startPrank(owner);
    if (k == 0) nft721.setApprovalForAll(address(vault), !nft721.isApprovedForAll(owner, address(vault)));
    else if (k == 1) nft721.setApprovalForAll(address(legacy), !nft721.isApprovedForAll(owner, address(legacy)));
    else if (k == 2) nft1155.setApprovalForAll(address(vault), !nft1155.isApprovedForAll(owner, address(vault)));
    else if (k == 3) nft1155.setApprovalForAll(address(legacy), !nft1155.isApprovedForAll(owner, address(legacy)));
    else if (k == 4) {
      uint256 id = (seed >> 8) % 3;
      if (nft721.ownerOf(id) == owner) nft721.transferFrom(owner, sink, id);
    } else if (k == 5) {
      uint256 id = (seed >> 8) % 2;
      uint256 have = nft1155.balanceOf(owner, id);
      if (have > 0) nft1155.safeTransferFrom(owner, sink, id, 1 + ((seed >> 16) % have), "");
    } else if (k == 6) {
      uint256 id = (seed >> 8) % 3;
      if (nft721.ownerOf(id) == owner) nft721.approve(nft721.getApproved(id) == address(legacy) ? address(0) : address(legacy), id);
    } else {
      vm.stopPrank();
      // Units come back to the owner (a gift, a purchase).
      uint256 id = (seed >> 8) % 2;
      uint256 have = nft1155.balanceOf(sink, id);
      if (have > 0) {
        vm.prank(sink);
        nft1155.safeTransferFrom(sink, owner, id, have, "");
      }
      _ok("v3.nftApprovals");
      return;
    }
    vm.stopPrank();
    _ok("v3.nftApprovals");
  }

  /// @dev M-1: the owner clears a binding to a legacy that is no longer live.
  function unbind() external {
    if (ownerDead) return;
    _op("v3.unbind");
    bool expect = vault.boundLegacy(owner) == address(legacy) && mActivated;
    vm.prank(owner);
    try vault.unbind() {
      _check(expect, "unbind accepted against the spec");
      _ok("v3.unbind");
    } catch {
      _check(!expect, "unbind refused against the spec");
    }
  }

  /// @dev Strangers and the executor try every way to move funds or settings.
  function stranger(uint256 seed) external {
    _op("v3.stranger");
    address who = seed % 2 == 0 ? eve : exe;
    address[] memory one = new address[](1);
    one[0] = address(tokA);
    uint256 k = (seed >> 1) % 6;
    vm.prank(who);
    bool ok;
    if (k == 0) {
      try legacy.activeLegacy(one, true, who) {
        ok = true;
      } catch {}
    } else if (k == 1) {
      try vault.pull(owner, address(tokC), who, 1) {
        ok = true;
      } catch {}
    } else if (k == 2) {
      try vault.pullERC721(owner, address(nft721), who, 0) {
        ok = true;
      } catch {}
    } else if (k == 3) {
      try legacy.setBackupLines(0, new TransferEOALegacyV3.BackupLine[](0)) {
        ok = true;
      } catch {}
    } else if (k == 4) {
      try legacy.withdraw(who, 1) {
        ok = true;
      } catch {}
    } else {
      try legacy.setNftItems(new TransferEOALegacyV3.NftItem[](0)) {
        ok = true;
      } catch {}
    }
    _check(!ok, "a stranger or the executor got through");
  }

  // ───────────── views for the invariant contract ─────────────

  function actorCount() external view returns (uint256) {
    return actors.length;
  }

  function wasShare(address who) external view returns (bool) {
    return isEverShare[who];
  }

  function everShareCount() external view returns (uint256) {
    return everShares.length;
  }

  function shareCount() external view returns (uint256) {
    return mShares.length;
  }

  function shareAt(uint256 i) external view returns (address) {
    return mShares[i];
  }

  function itemCount() external view returns (uint256) {
    return mItems.length;
  }

  function itemAt(uint256 i) external view returns (TransferEOALegacyV3.NftItem memory, uint256) {
    return (mItems[i], mMoved[i]);
  }

  function tokenAt(uint256 t) external view returns (address) {
    return tokens[t];
  }

  function modelDeadline() external view returns (uint256) {
    return _mDeadline();
  }

  function paymentAddr() external view returns (address) {
    return address(payment);
  }

  function vaultAddr() external view returns (address) {
    return address(vault);
  }
}
