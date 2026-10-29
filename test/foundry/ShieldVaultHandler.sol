// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ShieldVault} from "../../contracts/shield/ShieldVault.sol";
import {QuantumRecoveryRegistry} from "../../contracts/common/QuantumRecoveryRegistry.sol";
import {MockAwkwardERC20} from "../../contracts/mock/MockAwkwardERC20.sol";
import {MockReentrantShieldToken} from "../../contracts/mock/MockReentrantShieldToken.sol";
import {MockERC1271Wallet, MockERC1271WrongValue} from "../../contracts/mock/MockERC1271Wallets.sol";
import {ShieldVaultBase} from "./ShieldVaultBase.sol";

/**
 * @dev Stateful handler for the ShieldVault invariant suite. Every entry
 * point picks actors and arguments from a closed set, states the exact
 * condition under which the vault MUST accept the call (written from the
 * spec, not from the contract's checks), calls it, and verifies the
 * outcome. A wrong accept, a wrong refuse or a wrong effect is recorded in
 * `violations` with a message, never thrown, so one bad step cannot hide
 * behind a revert and `fail_on_revert` can stay on for the harness itself.
 *
 * The invariant contract reads the ghost state kept here to check the
 * global properties (solvency, digest disjointness, closed is terminal,
 * stored configs valid, ...) after every call.
 */
contract ShieldVaultHandler is ShieldVaultBase {
  // ───────────── actors ─────────────

  address[] public owners; // 3 EOAs and one ERC-1271 wallet
  address[] internal recoveries; // one recovery wallet per owner
  address[] internal bens; // beneficiary pool: 3 EOAs, the paper key, a mute contract
  address[] public payees; // every address that can ever hold an owed entry
  mapping(address => uint256) internal pkOf; // signer key of EOA or ERC-1271 payees (0: cannot sign)
  address internal paper;
  address internal mute;
  address internal thief;
  address internal relayer = makeAddr("relayer");
  uint256 internal forgerPk; // a key that is nobody's: every forged signature uses it

  MockAwkwardERC20 internal tokenA;
  MockAwkwardERC20 internal tokenB;
  MockReentrantShieldToken internal hostile;
  address[] public tokens;

  // ───────────── ghost state ─────────────

  struct Sheet {
    bytes32 secret;
    address recoveryTo;
    uint256 index; // registry index, NO_VETO when none
  }

  mapping(uint256 => Sheet) internal activeSheet;
  mapping(uint256 => Sheet) internal pendingSheet;
  mapping(uint256 => bytes32) public ghostPendingDigest;
  mapping(uint256 => bytes32) public ghostPendingConfigHash;
  mapping(uint256 => uint64) public ghostPendingReadyAt;
  mapping(uint256 => bytes32[]) internal ghostDigestsOf; // every non-zero digest a position ever held
  mapping(address => bytes32[]) internal ghostPinnedOf; // digests the vault must report pinned for the owner
  mapping(uint256 => uint16) public ghostFeeAtOpen;
  mapping(uint256 => bool) public ghostClosed;
  mapping(uint256 => bytes32) public ghostClosedSnapshot;
  mapping(address => uint256) public ghostDonations; // token => tokens sent straight to the vault

  uint256 public violations;
  string public lastViolation;
  mapping(string => uint256) public calls;
  mapping(string => uint256) public accepted;
  string[] internal opNames;
  mapping(string => bool) internal opSeen;

  constructor() {
    registry = new QuantumRecoveryRegistry();
    tokenA = new MockAwkwardERC20();
    tokenB = new MockAwkwardERC20();
    hostile = new MockReentrantShieldToken();
    token = tokenA;
    tokens.push(address(tokenA));
    tokens.push(address(tokenB));
    tokens.push(address(hostile));
    address[] memory listed = new address[](2);
    listed[0] = address(tokenA);
    listed[1] = address(tokenB);
    vault = new ShieldVault(registry, admin, listed, treasury, 25);
    vm.warp(1_800_000_000);

    for (uint256 i = 0; i < 3; i++) {
      (address o, uint256 pk) = makeAddrAndKey(string(abi.encodePacked("owner", i)));
      owners.push(o);
      pkOf[o] = pk;
    }
    (address walletSigner, uint256 walletPk) = makeAddrAndKey("walletSigner");
    MockERC1271Wallet wallet = new MockERC1271Wallet(walletSigner);
    owners.push(address(wallet));
    pkOf[address(wallet)] = walletPk; // its signatures come from the wallet's key through ERC-1271

    for (uint256 i = 0; i < owners.length; i++) {
      (address r, uint256 pk) = makeAddrAndKey(string(abi.encodePacked("recovery", i)));
      recoveries.push(r);
      pkOf[r] = pk;
    }
    string[3] memory names = ["alice", "bob", "carol"];
    for (uint256 i = 0; i < 3; i++) {
      (address b, uint256 pk) = makeAddrAndKey(names[i]);
      bens.push(b);
      pkOf[b] = pk;
    }
    uint256 paperPk;
    (paper, paperPk) = makeAddrAndKey("paper");
    pkOf[paper] = paperPk;
    bens.push(paper);
    mute = address(new MockERC1271WrongValue());
    bens.push(mute);
    uint256 thiefPk;
    (thief, thiefPk) = makeAddrAndKey("thief");
    pkOf[thief] = thiefPk;
    (, forgerPk) = makeAddrAndKey("forger");

    for (uint256 i = 0; i < owners.length; i++) payees.push(owners[i]);
    for (uint256 i = 0; i < recoveries.length; i++) payees.push(recoveries[i]);
    for (uint256 i = 0; i < bens.length; i++) payees.push(bens[i]);
    payees.push(thief);
    payees.push(relayer);
    payees.push(treasury);

    for (uint256 t = 0; t < tokens.length; t++) {
      for (uint256 i = 0; i < owners.length; i++) _fundToken(tokens[t], owners[i], 1e30);
      _fundToken(tokens[t], thief, 1e30);
    }

    _seedPositions();
  }

  /// @dev A starting state every run shares, so short sequences still reach
  /// the exits: five positions over three owners and two tokens, with and
  /// without sheets, with and without fallbacks, one with a paper key, one
  /// already waiting on a withdrawal.
  function _seedPositions() internal {
    address[] memory two = new address[](2);
    two[0] = bens[0];
    two[1] = bens[1];
    uint16[] memory sixtyForty = new uint16[](2);
    sixtyForty[0] = 6000;
    sixtyForty[1] = 4000;
    _seedOpen(owners[0], address(tokenA), 10e18, _cfg(uint32(30 days), uint32(365 days), two, sixtyForty, 0), true);

    address[] memory withPaper = new address[](2);
    withPaper[0] = bens[2];
    withPaper[1] = paper;
    uint16[] memory half = new uint16[](2);
    half[0] = 5000;
    half[1] = 5000;
    _seedOpen(owners[1], address(tokenB), 7e18, _cfg(uint32(7 days), uint32(180 days), withPaper, half, 2), true);

    _seedOpen(owners[2], address(tokenA), 3e18, _noFallback(uint32(90 days)), false);
    _seedOpen(owners[3], address(tokenA), 5e18, _single(uint32(7 days), uint32(200 days), mute), true);
    uint256 last = _seedOpen(owners[0], address(tokenB), 1e18, _single(uint32(30 days), uint32(1095 days), bens[2]), true);

    // One withdrawal already waiting, and one that has already failed into an
    // owed entry (its payee was blocked when the delay ran out), so claims and
    // "closed is terminal" have something to work on from the first call.
    vm.prank(owners[0]);
    vault.requestWithdraw(1, 2e18, bens[1]);
    ghostPendingReadyAt[1] = vault.positionOf(1).pending.readyAt;
    vm.prank(owners[0]);
    vault.requestWithdraw(last, ALL, bens[0]);
    ghostPendingReadyAt[last] = vault.positionOf(last).pending.readyAt;
    tokenB.setBlocked(bens[0], true);
    vm.warp(block.timestamp + 31 days);
    vault.executePending(last);
    tokenB.setBlocked(bens[0], false);
    _recordClose(last);
  }

  function _seedOpen(address owner, address tok, uint256 amount, ShieldVault.Config memory c, bool withSheet)
    internal
    returns (uint256 id)
  {
    Sheet memory sheet = Sheet(bytes32(0), address(0), NO_VETO);
    bytes32 digest;
    if (withSheet) {
      sheet.secret = keccak256(abi.encode("seed", owner, tok, amount));
      sheet.recoveryTo = _recoveryFor(owner);
      sheet.index = _commit(owner, sheet.secret, sheet.recoveryTo);
      digest = _vetoDigest(owner, sheet.secret, sheet.recoveryTo);
    }
    vm.prank(owner);
    id = vault.open(IERC20(tok), amount, c, sheet.index, MAX_FEE_BPS);
    _recordOpen(id, owner, sheet, digest);
  }

  function _recordOpen(uint256 id, address owner, Sheet memory sheet, bytes32 digest) internal {
    ghostFeeAtOpen[id] = vault.positionOf(id).feeBps;
    activeSheet[id] = sheet;
    if (digest != bytes32(0)) {
      ghostDigestsOf[id].push(digest);
      ghostPinnedOf[owner].push(digest);
      _check(vault.digestPinned(owner, digest), "open: digest not pinned for owner");
    }
  }

  function _fundToken(address tok, address who, uint256 amount) internal {
    if (tok == address(hostile)) hostile.mint(who, amount);
    else MockAwkwardERC20(tok).mint(who, amount);
    vm.prank(who);
    IERC20(tok).approve(address(vault), type(uint256).max);
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

  function opCount() external view returns (uint256) {
    return opNames.length;
  }

  function opAt(uint256 i) external view returns (string memory name, uint256 made, uint256 okd) {
    name = opNames[i];
    made = calls[name];
    okd = accepted[name];
  }

  function logSummary() external view {
    for (uint256 i = 0; i < opNames.length; i++) {
      console2.log("OP", opNames[i], calls[opNames[i]], accepted[opNames[i]]);
    }
  }

  /// @dev Appends one line per operation to `path` (name, calls, accepted),
  /// so a campaign's reach can be summed over all its runs.
  function writeSummary(string memory path) external {
    for (uint256 i = 0; i < opNames.length; i++) {
      vm.writeLine(
        path,
        string.concat(opNames[i], " ", vm.toString(calls[opNames[i]]), " ", vm.toString(accepted[opNames[i]]))
      );
    }
  }

  // ───────────── views for the invariant contract ─────────────

  function positionCount() external view returns (uint256) {
    return vault.positionCount();
  }

  function payeeCount() external view returns (uint256) {
    return payees.length;
  }

  function tokenCount() external view returns (uint256) {
    return tokens.length;
  }

  function ownerCount() external view returns (uint256) {
    return owners.length;
  }

  function thiefAddr() external view returns (address) {
    return thief;
  }

  function digestsOf(uint256 id) external view returns (bytes32[] memory) {
    return ghostDigestsOf[id];
  }

  function pinnedOf(address owner) external view returns (bytes32[] memory) {
    return ghostPinnedOf[owner];
  }

  function vaultAddr() external view returns (ShieldVault) {
    return vault;
  }

  function hostileToken() external view returns (MockReentrantShieldToken) {
    return hostile;
  }

  function configValid(ShieldVault.Config memory c) external view returns (bool) {
    return _configValid(c);
  }

  function isHeldInActiveConfig(uint256 id, address who) public view returns (bool) {
    ShieldVault.Position memory p = vault.positionOf(id);
    for (uint256 i = 0; i < p.config.beneficiaries.length; i++) {
      if (p.config.beneficiaries[i] == who) return (uint256(p.config.holdMask) >> i) & 1 == 1;
    }
    return false;
  }

  // ───────────── selection helpers ─────────────

  /// @dev Four calls in five prefer an open position; the fifth may land on
  /// a closed one so "closed is terminal" gets exercised too.
  function _pickId(uint256 seed) internal view returns (uint256) {
    uint256 n = vault.positionCount();
    if (n == 0) return 0;
    uint256 start = 1 + (seed % n);
    if (seed % 5 == 0) return start;
    for (uint256 k = 0; k < n; k++) {
      uint256 id = 1 + ((start - 1 + k) % n);
      if (!vault.positionOf(id).closed) return id;
    }
    return start;
  }

  /// @dev Three picks in four land on an (id, payee) pair that is actually
  /// owed something (when one exists, open or closed position alike); the
  /// fourth is any pair, so NothingOwed and the hold gate for strangers get
  /// exercised too.
  function _pickOwed(uint256 idSeed, uint256 payeeSeed) internal view returns (uint256 id, address payee) {
    uint256 n = vault.positionCount();
    uint256 m = payees.length;
    if (n == 0) return (0, payees[payeeSeed % m]);
    uint256 idStart = idSeed % n;
    uint256 pStart = payeeSeed % m;
    if (payeeSeed % 4 != 0) {
      for (uint256 a = 0; a < n; a++) {
        uint256 cand = 1 + ((idStart + a) % n);
        for (uint256 b = 0; b < m; b++) {
          address who = payees[(pStart + b) % m];
          if (vault.owed(cand, who) > 0) return (cand, who);
        }
      }
    }
    return (_pickId(idSeed), payees[pStart]);
  }

  function _recoveryFor(address owner) internal view returns (address) {
    for (uint256 i = 0; i < owners.length; i++) if (owners[i] == owner) return recoveries[i];
    return thief; // decoy positions belong to the thief
  }

  function _tokenOf(uint256 id) internal view returns (address) {
    return address(vault.positionOf(id).token);
  }

  function _isAwkward(address tok) internal view returns (bool) {
    return tok == address(tokenA) || tok == address(tokenB);
  }

  /// @dev What `to` receives when the vault (or anyone) transfers `amount` of `tok`.
  function _netOf(address tok, uint256 amount) internal view returns (uint256) {
    if (!_isAwkward(tok)) return amount;
    uint256 f = MockAwkwardERC20(tok).feeBps();
    if (f == 0) return amount;
    return amount - (amount * f) / BPS;
  }

  /// @dev Whether the token refuses a transfer from the vault to `to` right now.
  function _transferBlocked(address tok, address to) internal view returns (bool) {
    if (!_isAwkward(tok)) return false;
    MockAwkwardERC20 t = MockAwkwardERC20(tok);
    return t.blocked(address(vault)) || t.blocked(to);
  }

  function _pullBlocked(address tok, address from) internal view returns (bool) {
    if (!_isAwkward(tok)) return false;
    MockAwkwardERC20 t = MockAwkwardERC20(tok);
    return t.blocked(address(vault)) || t.blocked(from);
  }

  function _snapshot(uint256 id) internal view returns (bytes32) {
    return keccak256(abi.encode(vault.positionOf(id)));
  }

  /// @dev Hash of every position, owed entry and nonce: what the admin must not be able to reach.
  function _positionsDigest() internal view returns (bytes32) {
    uint256 n = vault.positionCount();
    bytes32 acc;
    for (uint256 id = 1; id <= n; id++) {
      acc = keccak256(abi.encode(acc, vault.positionOf(id)));
      for (uint256 j = 0; j < payees.length; j++) acc = keccak256(abi.encode(acc, vault.owed(id, payees[j])));
    }
    for (uint256 j = 0; j < payees.length; j++) {
      acc = keccak256(
        abi.encode(acc, vault.nonces(payees[j], 0), vault.nonces(payees[j], 1), vault.nonces(payees[j], 2))
      );
    }
    return acc;
  }

  /// @dev A mostly valid config drawn from the beneficiary pool; about one
  /// in twelve is deliberately broken so the validator's refusals are
  /// exercised against the mirror in the base.
  function _randomConfig(uint256 seed) internal view returns (ShieldVault.Config memory c) {
    uint256 r = uint256(keccak256(abi.encode(seed, "cfg")));
    c.exitDelay = _delayFor(r);
    uint256 shape = (r >> 8) % 12;
    if (shape == 0) {
      c.beneficiaries = new address[](0);
      c.sharesBps = new uint16[](0);
      return c;
    }
    uint256 n = 1 + ((r >> 16) % bens.length);
    c.silencePeriod = uint32(180 days + ((r >> 24) % (915 days + 1)));
    c.beneficiaries = new address[](n);
    uint256 offset = (r >> 40) % bens.length;
    for (uint256 i = 0; i < n; i++) c.beneficiaries[i] = bens[(offset + i) % bens.length];
    c.sharesBps = _shares(n, r >> 48);
    c.holdMask = uint16((r >> 64) % (1 << n));
    if (shape == 1) {
      uint256 how = (r >> 80) % 6;
      if (how == 0) c.exitDelay = uint32(1 days + ((r >> 88) % 100 days));
      else if (how == 1) c.silencePeriod = uint32((r >> 88) % 180 days);
      else if (how == 2) c.sharesBps[0] = c.sharesBps[0] + 1;
      else if (how == 3) c.holdMask = uint16(1 << n);
      else if (how == 4) c.beneficiaries[0] = address(vault);
      else if (n > 1) c.beneficiaries[1] = c.beneficiaries[0];
      else c.sharesBps[0] = 0;
    }
  }

  function _registryIndexOf(address owner, bytes32 digest) internal view returns (uint256) {
    uint256 n = registry.commitmentCount(owner);
    for (uint256 i = 0; i < n; i++) {
      if (registry.commitmentAt(owner, i).digest == digest) return i;
    }
    revert("digest not in registry");
  }

  // ───────────── owner flows ─────────────

  function open(uint256 ownerSeed, uint256 tokenSeed, uint256 amount, uint256 cfgSeed, uint256 vetoSeed, uint16 maxFee) external {
    _op("open");
    address owner = owners[ownerSeed % owners.length];
    address tok = tokens[tokenSeed % tokens.length];
    amount = bound(amount, 0, 1e24);
    // three in four callers accept the cap; the fourth probes FeeTooHigh around the rate in force
    maxFee = vetoSeed % 4 == 0 ? uint16(bound(maxFee, 0, 60)) : MAX_FEE_BPS;
    ShieldVault.Config memory c = _randomConfig(cfgSeed);

    // veto choice: fresh sheet (4/8), reuse of a pinned sheet, wrong scheme, out of range, none
    uint256 mode = vetoSeed % 8;
    uint256 index = NO_VETO;
    bytes32 expectDigest;
    Sheet memory sheet = Sheet(bytes32(0), address(0), NO_VETO);
    bool pinOk = true;
    if (mode <= 3) {
      sheet.secret = keccak256(abi.encode(vetoSeed, "secret", block.timestamp, vault.positionCount()));
      sheet.recoveryTo = _recoveryFor(owner);
      index = _commit(owner, sheet.secret, sheet.recoveryTo);
      sheet.index = index;
      expectDigest = _vetoDigest(owner, sheet.secret, sheet.recoveryTo);
    } else if (mode == 4 && ghostPinnedOf[owner].length > 0) {
      bytes32 d = ghostPinnedOf[owner][vetoSeed % ghostPinnedOf[owner].length];
      index = _registryIndexOf(owner, d);
      expectDigest = d;
      pinOk = false; // CommitmentReused
    } else if (mode == 5) {
      vm.prank(owner);
      index = registry.register(keccak256(abi.encode("pq key", vetoSeed)), 1, address(0));
      pinOk = false; // InvalidCommitment
    } else if (mode == 6) {
      index = registry.commitmentCount(owner) + (vetoSeed % 3); // out of range: registry panics
      pinOk = false;
    }

    bool shouldSucceed = vault.feeBps() <= maxFee && _configValid(c) && pinOk && !vault.depositsPaused()
      && vault.tokenSupported(tok) && amount > 0 && _netOf(tok, amount) > 0 && !_pullBlocked(tok, owner);
    uint256 expectedReceived = _netOf(tok, amount);
    uint256 before = IERC20(tok).balanceOf(address(vault));
    uint16 feeNow = vault.feeBps();
    uint256 countBefore = vault.positionCount();

    vm.prank(owner);
    try vault.open(IERC20(tok), amount, c, index, maxFee) returns (uint256 id) {
      _ok("open");
      _check(shouldSucceed, "open: accepted a call the spec refuses");
      _check(id == countBefore + 1 && vault.positionCount() == id, "open: id not sequential");
      ShieldVault.Position memory p = vault.positionOf(id);
      _check(p.owner == owner && address(p.token) == tok && !p.closed, "open: wrong owner/token/closed");
      _check(p.balance == expectedReceived, "open: credited more or less than arrived");
      _check(p.feeBps == feeNow && p.feeBps <= MAX_FEE_BPS && p.feeBps <= maxFee, "open: fee not the one in force");
      _check(p.lastActivity == uint64(block.timestamp), "open: lastActivity not now");
      _check(p.vetoDigest == expectDigest, "open: pinned digest differs from the registry entry");
      _check(p.pending.kind == ShieldVault.PendingKind.None, "open: pending not empty");
      _check(_configHash(p.config) == _configHash(c), "open: stored config differs");
      _check(IERC20(tok).balanceOf(address(vault)) == before + expectedReceived, "open: vault balance delta");
      _recordOpen(id, owner, sheet, expectDigest);
    } catch {
      _check(!shouldSucceed, "open: refused a call the spec accepts");
      _check(vault.positionCount() == countBefore, "open: refused but count moved");
    }
  }

  function deposit(uint256 idSeed, uint256 amount, bool byOwner) external {
    _op("deposit");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    amount = bound(amount, 0, 1e24);
    ShieldVault.Position memory p = vault.positionOf(id);
    address tok = address(p.token);
    address from = byOwner ? p.owner : thief;
    bool shouldSucceed = !p.closed && !vault.depositsPaused() && vault.tokenSupported(tok) && amount > 0
      && _netOf(tok, amount) > 0 && !_pullBlocked(tok, from);
    uint256 expectedReceived = _netOf(tok, amount);
    uint256 before = IERC20(tok).balanceOf(address(vault));

    vm.prank(from);
    try vault.deposit(id, amount) {
      _ok("deposit");
      _check(shouldSucceed, "deposit: accepted a call the spec refuses");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.balance == p.balance + expectedReceived, "deposit: credited more or less than arrived");
      _check(IERC20(tok).balanceOf(address(vault)) == before + expectedReceived, "deposit: vault balance delta");
      // decoy positions belong to the thief, so "stranger" is decided by address, not by role
      if (from == p.owner) _check(q.lastActivity == uint64(block.timestamp), "deposit: owner deposit is activity");
      else _check(q.lastActivity == p.lastActivity, "deposit: stranger deposit moved lastActivity (I10)");
      _check(q.pending.kind == p.pending.kind && q.pending.readyAt == p.pending.readyAt, "deposit: touched pending");
    } catch {
      _check(!shouldSucceed, "deposit: refused a call the spec accepts");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "deposit: refused but state moved");
    }
  }

  function checkIn(uint256 idSeed, bool asOwner) external {
    _op("checkIn");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    address caller = asOwner ? p.owner : thief;
    bool shouldSucceed = !p.closed && caller == p.owner;
    vm.prank(caller);
    try vault.checkIn(id) {
      _ok("checkIn");
      _check(shouldSucceed, "checkIn: accepted a call the spec refuses");
      _check(vault.positionOf(id).lastActivity == uint64(block.timestamp), "checkIn: lastActivity not now");
    } catch {
      _check(!shouldSucceed, "checkIn: refused a call the spec accepts");
      _check(vault.positionOf(id).lastActivity == p.lastActivity, "checkIn: refused but moved lastActivity");
    }
  }

  function checkInWithSig(uint256 idSeed, uint8 flaw) external {
    _op("checkInWithSig");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    flaw = uint8(flaw % 5); // 0: good, 1: forged, 2: expired, 3: wrong nonce, 4: wrong id
    uint256 pk = flaw == 1 ? forgerPk : pkOf[p.owner];
    uint256 nonceBefore = vault.nonces(p.owner, 0);
    uint256 nonce = nonceBefore + (flaw == 3 ? 1 : 0);
    uint256 deadline = flaw == 2 ? block.timestamp - 1 : block.timestamp + 1 hours;
    bytes memory sig = _signCheckIn(pk, flaw == 4 ? id + 1 : id, nonce, deadline);
    bool shouldSucceed = !p.closed && flaw == 0;

    vm.prank(relayer);
    try vault.checkInWithSig(id, deadline, sig) {
      _ok("checkInWithSig");
      _check(shouldSucceed, "checkInWithSig: accepted a bad signature (I18)");
      _check(vault.positionOf(id).lastActivity == uint64(block.timestamp), "checkInWithSig: lastActivity not now");
      _check(vault.nonces(p.owner, 0) == nonceBefore + 1, "checkInWithSig: nonce not consumed");
    } catch {
      _check(!shouldSucceed, "checkInWithSig: refused a valid signature");
      _check(vault.positionOf(id).lastActivity == p.lastActivity, "checkInWithSig: refused but moved lastActivity");
      _check(vault.nonces(p.owner, 0) == nonceBefore, "checkInWithSig: refused but consumed nonce");
    }
  }

  function requestWithdraw(uint256 idSeed, uint256 amountSeed, uint256 toSeed, bool asOwner) external {
    _op("requestWithdraw");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    uint256 amount;
    uint256 kind = amountSeed % 8;
    if (kind == 0) amount = ALL;
    else if (kind == 1) amount = 0;
    else if (kind == 2) amount = p.balance + 1;
    else if (kind == 3) amount = p.balance;
    else amount = p.balance == 0 ? 1 : 1 + ((amountSeed >> 8) % p.balance);
    address to;
    uint256 toKind = toSeed % 12;
    if (toKind == 0) to = address(0);
    else if (toKind == 1) to = address(vault);
    else to = payees[(toSeed >> 8) % payees.length];
    address caller = asOwner ? p.owner : thief;
    bool shouldSucceed = !p.closed && caller == p.owner && p.pending.kind == ShieldVault.PendingKind.None
      && amount != 0 && (amount == ALL || amount <= p.balance) && to != address(0) && to != address(vault);

    vm.prank(caller);
    try vault.requestWithdraw(id, amount, to) {
      _ok("requestWithdraw");
      _check(shouldSucceed, "requestWithdraw: accepted a call the spec refuses");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.pending.kind == ShieldVault.PendingKind.Withdraw, "requestWithdraw: kind");
      _check(q.pending.readyAt == uint64(block.timestamp) + p.config.exitDelay, "requestWithdraw: readyAt != now + delay in force (I3)");
      _check(q.pending.amount == amount && q.pending.to == to, "requestWithdraw: amount/to not stored");
      _check(q.lastActivity == uint64(block.timestamp), "requestWithdraw: not activity");
      _check(q.balance == p.balance && q.vetoDigest == p.vetoDigest, "requestWithdraw: moved balance or digest");
      ghostPendingReadyAt[id] = q.pending.readyAt;
    } catch {
      _check(!shouldSucceed, "requestWithdraw: refused a call the spec accepts");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "requestWithdraw: refused but state moved");
    }
  }

  function requestChange(uint256 idSeed, uint256 cfgSeed, uint256 vetoSeed, bool asOwner) external {
    _op("requestChange");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    ShieldVault.Config memory c = _randomConfig(cfgSeed);
    address caller = asOwner ? p.owner : thief;

    uint256 mode = vetoSeed % 8;
    uint256 index = NO_VETO;
    bytes32 expectDigest;
    Sheet memory sheet = Sheet(bytes32(0), address(0), NO_VETO);
    bool pinOk = true;
    bool freshPin;
    if (mode <= 2) {
      sheet.secret = keccak256(abi.encode(vetoSeed, "change", block.timestamp, id));
      sheet.recoveryTo = _recoveryFor(p.owner);
      index = _commit(p.owner, sheet.secret, sheet.recoveryTo);
      sheet.index = index;
      expectDigest = _vetoDigest(p.owner, sheet.secret, sheet.recoveryTo);
      freshPin = true;
    } else if (mode == 3 && activeSheet[id].index != NO_VETO) {
      sheet = activeSheet[id]; // keep the current sheet
      index = sheet.index;
      expectDigest = p.vetoDigest;
    } else if (mode == 4 && ghostPinnedOf[p.owner].length > 0) {
      bytes32 d = ghostPinnedOf[p.owner][vetoSeed % ghostPinnedOf[p.owner].length];
      index = _registryIndexOf(p.owner, d);
      expectDigest = d;
      if (d != p.vetoDigest) pinOk = false; // CommitmentReused, unless it is the current one
      else sheet = activeSheet[id];
    } else if (mode == 5) {
      vm.prank(p.owner);
      index = registry.register(keccak256(abi.encode("pq key", vetoSeed, id)), 2, address(0));
      pinOk = false;
    }
    // mode 6, 7 and fallthroughs: NO_VETO (removing the sheet after the delay)

    bool shouldSucceed =
      !p.closed && caller == p.owner && p.pending.kind == ShieldVault.PendingKind.None && _configValid(c) && pinOk;

    vm.prank(caller);
    try vault.requestChange(id, c, index) {
      _ok("requestChange");
      _check(shouldSucceed, "requestChange: accepted a call the spec refuses");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.pending.kind == ShieldVault.PendingKind.Change, "requestChange: kind");
      _check(q.pending.readyAt == uint64(block.timestamp) + p.config.exitDelay, "requestChange: readyAt != now + CURRENT delay (I3)");
      _check(q.pending.vetoDigest == expectDigest, "requestChange: pending digest differs from registry entry");
      _check(_configHash(q.pending.config) == _configHash(c), "requestChange: pending config differs");
      _check(q.vetoDigest == p.vetoDigest && _configHash(q.config) == _configHash(p.config), "requestChange: applied early (I3)");
      _check(q.lastActivity == uint64(block.timestamp), "requestChange: not activity");
      ghostPendingReadyAt[id] = q.pending.readyAt;
      ghostPendingDigest[id] = expectDigest;
      ghostPendingConfigHash[id] = _configHash(c);
      pendingSheet[id] = sheet;
      if (expectDigest != bytes32(0)) {
        ghostDigestsOf[id].push(expectDigest);
        if (freshPin) ghostPinnedOf[p.owner].push(expectDigest);
        _check(vault.digestPinned(p.owner, expectDigest), "requestChange: digest not pinned for owner");
      }
    } catch {
      _check(!shouldSucceed, "requestChange: refused a call the spec accepts");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "requestChange: refused but state moved");
    }
  }

  function cancelPending(uint256 idSeed, bool asOwner) external {
    _op("cancelPending");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    address caller = asOwner ? p.owner : thief;
    bool shouldSucceed = !p.closed && caller == p.owner && p.pending.kind != ShieldVault.PendingKind.None;
    vm.prank(caller);
    try vault.cancelPending(id) {
      _ok("cancelPending");
      _check(shouldSucceed, "cancelPending: accepted a call the spec refuses");
      _afterCancel(id, p);
    } catch {
      _check(!shouldSucceed, "cancelPending: refused a call the spec accepts");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "cancelPending: refused but state moved");
    }
  }

  function _afterCancel(uint256 id, ShieldVault.Position memory p) internal {
    ShieldVault.Position memory q = vault.positionOf(id);
    _check(q.pending.kind == ShieldVault.PendingKind.None, "cancel: pending not cleared");
    _check(q.lastActivity == uint64(block.timestamp), "cancel: not activity");
    _check(
      q.balance == p.balance && q.vetoDigest == p.vetoDigest && _configHash(q.config) == _configHash(p.config),
      "cancel: moved balance/digest/config"
    );
    // A cancelled change leaves its digest burned for the owner (accepted design, Q3).
    if (p.pending.kind == ShieldVault.PendingKind.Change && p.pending.vetoDigest != bytes32(0)) {
      _check(vault.digestPinned(p.owner, p.pending.vetoDigest), "cancel: pending digest unpinned");
    }
    delete pendingSheet[id];
  }

  function cancelPendingWithSig(uint256 idSeed, uint8 flaw) external {
    _op("cancelPendingWithSig");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    flaw = uint8(flaw % 4); // 0: good, 1: forged, 2: stale readyAt, 3: expired
    uint256 pk = flaw == 1 ? forgerPk : pkOf[p.owner];
    uint64 readyAt = flaw == 2 ? p.pending.readyAt + 1 : p.pending.readyAt;
    uint256 nonce = vault.nonces(p.owner, 1);
    uint256 deadline = flaw == 3 ? block.timestamp - 1 : block.timestamp + 1 hours;
    bytes memory sig = _signCancel(pk, id, readyAt, nonce, deadline);
    bool shouldSucceed = !p.closed && p.pending.kind != ShieldVault.PendingKind.None && flaw == 0;

    vm.prank(relayer);
    try vault.cancelPendingWithSig(id, deadline, sig) {
      _ok("cancelPendingWithSig");
      _check(shouldSucceed, "cancelPendingWithSig: accepted a bad or stale signature (I18)");
      _check(vault.nonces(p.owner, 1) == nonce + 1, "cancelPendingWithSig: nonce not consumed");
      _afterCancel(id, p);
    } catch {
      _check(!shouldSucceed, "cancelPendingWithSig: refused a valid signature");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "cancelPendingWithSig: refused but state moved");
      _check(vault.nonces(p.owner, 1) == nonce, "cancelPendingWithSig: refused but consumed nonce");
    }
  }

  // ───────────── permissionless exits ─────────────

  function executePending(uint256 idSeed) external {
    _op("executePending");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    address tok = address(p.token);
    bool isWithdraw = p.pending.kind == ShieldVault.PendingKind.Withdraw;
    bool shouldSucceed =
      !p.closed && p.pending.kind != ShieldVault.PendingKind.None && block.timestamp >= p.pending.readyAt;
    uint256 feesBefore = vault.feesAccrued(tok);
    uint256 toBalBefore = isWithdraw ? IERC20(tok).balanceOf(p.pending.to) : 0;
    uint256 owedBefore = isWithdraw ? vault.owed(id, p.pending.to) : 0;
    uint256 vaultBefore = IERC20(tok).balanceOf(address(vault));

    vm.prank(relayer);
    try vault.executePending(id) {
      _ok("executePending");
      _check(shouldSucceed, "executePending: ran before readyAt or without pending (I3)");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.pending.kind == ShieldVault.PendingKind.None, "executePending: pending not cleared");
      _check(q.lastActivity == p.lastActivity, "executePending: moved lastActivity (I10)");
      if (isWithdraw) {
        uint256 amount = p.pending.amount == ALL ? p.balance : p.pending.amount;
        uint256 fee = _fee(amount, p.feeBps);
        uint256 net = amount - fee;
        _check(q.balance == p.balance - amount, "executePending: balance delta != amount");
        _check(q.closed == (q.balance == 0), "executePending: closed iff empty (I12)");
        _check(vault.feesAccrued(tok) == feesBefore + fee, "executePending: fee != floor(amount*feeBps/1e4) (I17)");
        _check(q.vetoDigest == p.vetoDigest && _configHash(q.config) == _configHash(p.config), "executePending(W): touched config/digest");
        uint256 toDelta = IERC20(tok).balanceOf(p.pending.to) - toBalBefore;
        uint256 owedDelta = vault.owed(id, p.pending.to) - owedBefore;
        bool paid = toDelta == _netOf(tok, net) && owedDelta == 0;
        bool owedInstead = toDelta == 0 && owedDelta == net;
        _check(paid || owedInstead, "executePending: payee neither paid net nor owed net (I2, I14)");
        _check(vaultBefore - IERC20(tok).balanceOf(address(vault)) == (paid ? net : 0), "executePending: vault debited != paid");
        if (q.closed) _recordClose(id);
      } else {
        _check(q.vetoDigest == ghostPendingDigest[id], "executePending(C): active digest != pinned at request (I5)");
        _check(_configHash(q.config) == ghostPendingConfigHash[id], "executePending(C): config != requested");
        _check(q.balance == p.balance && vault.feesAccrued(tok) == feesBefore, "executePending(C): moved funds");
        _check(IERC20(tok).balanceOf(address(vault)) == vaultBefore, "executePending(C): vault balance moved");
        activeSheet[id] = pendingSheet[id];
        delete pendingSheet[id];
      }
    } catch {
      _check(!shouldSucceed, "executePending: refused a ready operation (pause/listing/admin must not matter, I7/I8)");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "executePending: refused but state moved");
    }
  }

  function veto(uint256 idSeed, uint8 mode) external {
    _op("veto");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    address tok = address(p.token);
    mode = uint8(mode % 6); // 0..2: the active sheet, 3: wrong secret, 4: wrong destination, 5: the pending sheet
    Sheet memory s = mode == 5 ? pendingSheet[id] : activeSheet[id];
    bytes32 secret = s.secret;
    address to = s.recoveryTo;
    if (mode == 3) secret = keccak256(abi.encode("wrong", secret));
    if (mode == 4) to = thief;
    if (to == address(0)) to = _recoveryFor(p.owner);
    bool rightSheet = p.vetoDigest != bytes32(0) && _vetoDigest(p.owner, secret, to) == p.vetoDigest;
    bool shouldSucceed = !p.closed && rightSheet;
    uint256 feesBefore = vault.feesAccrued(tok);
    uint256 toBefore = IERC20(tok).balanceOf(to);
    uint256 owedBefore = vault.owed(id, to);
    uint256 vaultBefore = IERC20(tok).balanceOf(address(vault));

    vm.prank(relayer);
    try vault.veto(id, secret, to) {
      _ok("veto");
      _check(shouldSucceed, "veto: accepted a wrong secret, destination or closed position (I5)");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.balance == 0 && q.closed, "veto: not emptied and closed");
      _check(q.pending.kind == ShieldVault.PendingKind.None, "veto: pending not cleared");
      _check(vault.feesAccrued(tok) == feesBefore, "veto: charged a fee (I4)");
      _check(q.lastActivity == p.lastActivity, "veto: moved lastActivity");
      uint256 toDelta = IERC20(tok).balanceOf(to) - toBefore;
      uint256 owedDelta = vault.owed(id, to) - owedBefore;
      bool paid = toDelta == _netOf(tok, p.balance) && owedDelta == 0;
      bool owedInstead = toDelta == 0 && owedDelta == p.balance;
      _check(paid || owedInstead, "veto: recovery wallet neither paid nor owed the full balance (I4, I14)");
      _check(vaultBefore - IERC20(tok).balanceOf(address(vault)) == (paid ? p.balance : 0), "veto: vault debited != paid");
      delete pendingSheet[id];
      _recordClose(id);
    } catch {
      _check(!shouldSucceed, "veto: refused the right sheet on an open position (I4)");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "veto: refused but state moved");
    }
  }

  function executeFallback(uint256 idSeed) external {
    _op("executeFallback");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    address tok = address(p.token);
    uint32 silence = p.config.silencePeriod;
    bool shouldSucceed = !p.closed && silence != 0 && p.pending.kind == ShieldVault.PendingKind.None
      && block.timestamp >= uint256(p.lastActivity) + silence;
    uint256 n = p.config.beneficiaries.length;
    uint256[] memory balBefore = new uint256[](n);
    uint256[] memory owedBefore = new uint256[](n);
    for (uint256 i = 0; i < n; i++) {
      balBefore[i] = IERC20(tok).balanceOf(p.config.beneficiaries[i]);
      owedBefore[i] = vault.owed(id, p.config.beneficiaries[i]);
    }
    uint256 feesBefore = vault.feesAccrued(tok);
    uint256 vaultBefore = IERC20(tok).balanceOf(address(vault));

    vm.prank(relayer);
    try vault.executeFallback(id) {
      _ok("executeFallback");
      _check(shouldSucceed, "executeFallback: ran while owner active, pending, or no fallback (I9)");
      ShieldVault.Position memory q = vault.positionOf(id);
      _check(q.balance == 0 && q.closed, "executeFallback: not emptied and closed");
      _check(q.lastActivity == p.lastActivity, "executeFallback: moved lastActivity");
      uint256 fee = _fee(p.balance, p.feeBps);
      uint256 total = p.balance - fee;
      _check(vault.feesAccrued(tok) == feesBefore + fee, "executeFallback: fee != floor(balance*feeBps/1e4) (I17)");
      uint256 paidOut;
      uint256 accounted;
      for (uint256 i = 0; i < n; i++) {
        uint256 share = i == n - 1 ? total - accounted : (total * p.config.sharesBps[i]) / BPS;
        accounted += share;
        uint256 bDelta = IERC20(tok).balanceOf(p.config.beneficiaries[i]) - balBefore[i];
        uint256 oDelta = vault.owed(id, p.config.beneficiaries[i]) - owedBefore[i];
        bool held = (uint256(p.config.holdMask) >> i) & 1 == 1;
        if (share == 0) {
          _check(bDelta == 0 && oDelta == 0, "executeFallback: zero share moved something");
        } else if (held) {
          _check(bDelta == 0 && oDelta == share, "executeFallback: held share was sent or mis-recorded (I9, I19)");
        } else {
          bool paid = bDelta == _netOf(tok, share) && oDelta == 0;
          bool owedInstead = bDelta == 0 && oDelta == share;
          _check(paid || owedInstead, "executeFallback: beneficiary neither paid nor owed its floor share (I9)");
          if (paid) paidOut += share;
        }
      }
      _check(accounted == total, "executeFallback: shares do not sum to total");
      _check(vaultBefore - IERC20(tok).balanceOf(address(vault)) == paidOut, "executeFallback: vault debited != paid");
      _recordClose(id);
    } catch {
      _check(!shouldSucceed, "executeFallback: refused a due release (pause/listing/admin must not matter, I7/I8)");
      _check(_snapshot(id) == keccak256(abi.encode(p)), "executeFallback: refused but state moved");
    }
  }

  function _recordClose(uint256 id) internal {
    ghostClosed[id] = true;
    ghostClosedSnapshot[id] = _snapshot(id);
  }

  function claimOwed(uint256 idSeed, uint256 payeeSeed, uint8 callerKind) external {
    _op("claimOwed");
    (uint256 id, address payee) = _pickOwed(idSeed, payeeSeed);
    if (id == 0) return;
    address caller = callerKind % 3 == 0 ? payee : relayer;
    address tok = _tokenOf(id);
    uint256 owedBefore = vault.owed(id, payee);
    bool gated = caller != payee && payee.code.length == 0 && isHeldInActiveConfig(id, payee);
    bool shouldSucceed = !gated && owedBefore > 0 && !_transferBlocked(tok, payee);
    uint256 balBefore = IERC20(tok).balanceOf(payee);
    bytes32 snap = _snapshot(id);
    vm.prank(caller);
    try vault.claimOwed(id, payee) {
      _ok("claimOwed");
      _check(shouldSucceed, "claimOwed: accepted (held share pushed by a stranger, or nothing owed) (I19)");
      _check(vault.owed(id, payee) == 0, "claimOwed: owed not cleared");
      _check(IERC20(tok).balanceOf(payee) - balBefore == _netOf(tok, owedBefore), "claimOwed: paid != owed (I2)");
      _check(_snapshot(id) == snap, "claimOwed: touched the position");
    } catch {
      _check(!shouldSucceed, "claimOwed: refused a legitimate claim (I14)");
      _check(vault.owed(id, payee) == owedBefore, "claimOwed: refused but owed moved");
    }
  }

  function claimOwedWithSig(uint256 idSeed, uint256 payeeSeed, uint256 toSeed, uint8 flaw) external {
    _op("claimOwedWithSig");
    (uint256 id, address payee) = _pickOwed(idSeed, payeeSeed);
    if (id == 0) return;
    address tok = _tokenOf(id);
    address to;
    uint256 toKind = toSeed % 10;
    if (toKind == 0) to = address(0);
    else if (toKind == 1) to = address(vault);
    else to = payees[(toSeed >> 8) % payees.length];
    flaw = uint8(flaw % 4); // 0: good, 1: forged, 2: expired, 3: redirected after signing
    uint256 pk = pkOf[payee];
    bool canSign = pk != 0; // the mute contract has no key and no ERC-1271
    if (flaw == 1 || !canSign) pk = forgerPk;
    uint256 nonce = vault.nonces(payee, 2);
    uint256 deadline = flaw == 2 ? block.timestamp - 1 : block.timestamp + 1 hours;
    // the "redirected" flaw signs for a destination that is certainly not the one submitted
    address signedTo = flaw == 3 ? (to == thief ? relayer : thief) : to;
    bytes memory sig = _signClaim(pk, id, payee, signedTo, nonce, deadline);
    uint256 owedBefore = vault.owed(id, payee);
    bool shouldSucceed = to != address(0) && to != address(vault) && flaw == 0 && canSign && owedBefore > 0
      && !_transferBlocked(tok, to);
    uint256 toBefore = IERC20(tok).balanceOf(to);
    bytes32 snap = _snapshot(id);

    vm.prank(relayer);
    try vault.claimOwedWithSig(id, payee, to, deadline, sig) {
      _ok("claimOwedWithSig");
      _check(shouldSucceed, "claimOwedWithSig: accepted a bad signature or destination (I18, I19)");
      _check(vault.owed(id, payee) == 0, "claimOwedWithSig: owed not cleared");
      _check(IERC20(tok).balanceOf(to) - toBefore == _netOf(tok, owedBefore), "claimOwedWithSig: paid != owed (I2)");
      _check(vault.nonces(payee, 2) == nonce + 1, "claimOwedWithSig: nonce not consumed");
      _check(_snapshot(id) == snap, "claimOwedWithSig: touched the position");
    } catch {
      _check(!shouldSucceed, "claimOwedWithSig: refused a valid claim");
      _check(vault.owed(id, payee) == owedBefore, "claimOwedWithSig: refused but owed moved");
      _check(vault.nonces(payee, 2) == nonce, "claimOwedWithSig: refused but consumed nonce");
    }
  }

  function collectFees(uint256 tokenSeed) external {
    _op("collectFees");
    address tok = tokens[tokenSeed % tokens.length];
    uint256 accrued = vault.feesAccrued(tok);
    address to = vault.feeRecipient();
    bool shouldSucceed = accrued > 0 && !_transferBlocked(tok, to);
    uint256 before = IERC20(tok).balanceOf(to);
    bytes32 digest = _positionsDigest();
    uint256[] memory otherFees = new uint256[](tokens.length);
    for (uint256 t = 0; t < tokens.length; t++) otherFees[t] = vault.feesAccrued(tokens[t]);
    vm.prank(relayer);
    try vault.collectFees(IERC20(tok)) {
      _ok("collectFees");
      _check(shouldSucceed, "collectFees: accepted with nothing accrued");
      _check(vault.feesAccrued(tok) == 0, "collectFees: not zeroed");
      _check(IERC20(tok).balanceOf(to) - before == _netOf(tok, accrued), "collectFees: paid != accrued (I2)");
    } catch {
      _check(!shouldSucceed, "collectFees: refused a collectable amount");
      _check(vault.feesAccrued(tok) == accrued, "collectFees: refused but moved");
    }
    _check(_positionsDigest() == digest, "collectFees: reached a position or owed entry");
    for (uint256 t = 0; t < tokens.length; t++) {
      if (tokens[t] != tok) _check(vault.feesAccrued(tokens[t]) == otherFees[t], "collectFees: moved another token's fees (I16, I17)");
    }
  }

  // ───────────── admin (must have no reach) ─────────────

  function adminSetFee(uint16 bps) external {
    _op("admin.setFee");
    bps = uint16(bound(bps, 0, 60));
    bytes32 before = _positionsDigest();
    vm.prank(admin);
    try vault.setFee(bps) {
      _ok("admin.setFee");
      _check(bps <= MAX_FEE_BPS, "setFee: accepted above the cap (I17)");
      _check(vault.feeBps() == bps, "setFee: not stored");
    } catch {
      _check(bps > MAX_FEE_BPS, "setFee: refused a legal rate");
    }
    _check(_positionsDigest() == before, "setFee: reached a position (I7)");
  }

  function adminSetFeeRecipient(uint256 seed) external {
    _op("admin.setFeeRecipient");
    uint256 k = seed % 10;
    address to = k == 0 ? address(0) : k == 1 ? address(vault) : payees[(seed >> 8) % payees.length];
    bytes32 before = _positionsDigest();
    address prev = vault.feeRecipient();
    vm.prank(admin);
    try vault.setFeeRecipient(to) {
      _ok("admin.setFeeRecipient");
      _check(to != address(0) && to != address(vault), "setFeeRecipient: accepted zero or vault");
      _check(vault.feeRecipient() == to, "setFeeRecipient: not stored");
    } catch {
      _check(to == address(0) || to == address(vault), "setFeeRecipient: refused a legal address");
      _check(vault.feeRecipient() == prev, "setFeeRecipient: refused but moved");
    }
    _check(_positionsDigest() == before, "setFeeRecipient: reached a position (I7)");
  }

  function adminSetTokenSupported(uint256 tokenSeed, uint8 supportedSeed) external {
    _op("admin.setTokenSupported");
    address tok = tokens[tokenSeed % tokens.length];
    bool supported = supportedSeed % 4 != 0; // delisted one time in four
    bytes32 before = _positionsDigest();
    vm.prank(admin);
    vault.setTokenSupported(tok, supported);
    _ok("admin.setTokenSupported");
    _check(vault.tokenSupported(tok) == supported, "setTokenSupported: not stored");
    _check(_positionsDigest() == before, "setTokenSupported: reached a position (I7)");
  }

  function adminSetDepositsPaused(uint8 pausedSeed) external {
    _op("admin.setDepositsPaused");
    bool paused = pausedSeed % 4 == 0; // paused one time in four
    bytes32 before = _positionsDigest();
    vm.prank(admin);
    vault.setDepositsPaused(paused);
    _ok("admin.setDepositsPaused");
    _check(vault.depositsPaused() == paused, "setDepositsPaused: not stored");
    _check(_positionsDigest() == before, "setDepositsPaused: reached a position (I7)");
  }

  function strangerAdmin(uint8 which, uint256 seed) external {
    _op("stranger.admin");
    which = uint8(which % 4);
    bytes32 before = _positionsDigest();
    uint16 feeBefore = vault.feeBps();
    address recBefore = vault.feeRecipient();
    bool pausedBefore = vault.depositsPaused();
    address tok = tokens[seed % tokens.length];
    bool supBefore = vault.tokenSupported(tok);
    bool ok;
    vm.prank(thief);
    if (which == 0) {
      try vault.setFee(1) {
        ok = true;
      } catch {}
    } else if (which == 1) {
      try vault.setFeeRecipient(thief) {
        ok = true;
      } catch {}
    } else if (which == 2) {
      try vault.setDepositsPaused(!pausedBefore) {
        ok = true;
      } catch {}
    } else {
      try vault.setTokenSupported(tok, !supBefore) {
        ok = true;
      } catch {}
    }
    _check(!ok, "stranger: admin setter accepted");
    _check(
      vault.feeBps() == feeBefore && vault.feeRecipient() == recBefore && vault.depositsPaused() == pausedBefore
        && vault.tokenSupported(tok) == supBefore,
      "stranger: admin state moved"
    );
    _check(_positionsDigest() == before, "stranger: reached a position");
  }

  // ───────────── the environment: tokens, time, third parties ─────────────

  function setTokenFee(uint256 tokenSeed, uint256 bps) external {
    _op("env.tokenFee");
    MockAwkwardERC20 t = tokenSeed % 2 == 0 ? tokenA : tokenB;
    uint256 k = bps % 20;
    // mostly 0, sometimes a small fee, rarely a total burn (NothingReceived)
    uint256 fee = k < 10 ? 0 : k < 19 ? 1 + ((bps >> 8) % 100) : BPS;
    t.setFeeBps(fee);
    _ok("env.tokenFee");
  }

  function setBlocked(uint256 tokenSeed, uint256 whoSeed, bool blocked) external {
    _op("env.blocklist");
    MockAwkwardERC20 t = tokenSeed % 2 == 0 ? tokenA : tokenB;
    // one in ten targets the vault itself (a token-wide pause from the vault's
    // point of view); half target someone a position is about to pay
    uint256 k = whoSeed % 10;
    address who = k == 0 ? address(vault) : k <= 5 ? _pickRelated(whoSeed >> 8) : payees[(whoSeed >> 8) % payees.length];
    // a blocked vault turns every payout into an owed entry; keep it rare so claims still happen
    if (who == address(vault)) blocked = blocked && (whoSeed >> 4) % 4 == 0;
    t.setBlocked(who, blocked);
    _ok("env.blocklist");
  }

  /// @dev A beneficiary, pending payee or recovery wallet of some position.
  function _pickRelated(uint256 seed) internal view returns (address) {
    uint256 id = _pickId(seed);
    if (id == 0) return payees[seed % payees.length];
    ShieldVault.Position memory p = vault.positionOf(id);
    uint256 n = p.config.beneficiaries.length;
    uint256 k = (seed >> 16) % (n + 2);
    if (k < n) return p.config.beneficiaries[k];
    if (k == n && p.pending.kind == ShieldVault.PendingKind.Withdraw) return p.pending.to;
    return _recoveryFor(p.owner);
  }

  function donate(uint256 tokenSeed, uint256 amount) external {
    _op("env.donate");
    address tok = tokens[tokenSeed % tokens.length];
    amount = bound(amount, 1, 1e20);
    if (_pullBlocked(tok, thief)) return;
    // A direct transfer is not a vault call: a hook firing here would be a legitimate
    // outside call, not a re-entry, so it must not count against the guard.
    if (tok == address(hostile)) hostile.disarm();
    uint256 before = IERC20(tok).balanceOf(address(vault));
    vm.prank(thief);
    IERC20(tok).transfer(address(vault), amount);
    ghostDonations[tok] += IERC20(tok).balanceOf(address(vault)) - before;
    _ok("env.donate");
  }

  function warp(uint256 seconds_) external {
    _op("env.warp");
    uint256 k = seconds_ % 6;
    uint256 jump = k == 0
      ? 1 + ((seconds_ >> 8) % 1 hours)
      : k <= 2 ? 1 days + ((seconds_ >> 8) % 100 days) : 100 days + ((seconds_ >> 8) % 1000 days);
    vm.warp(block.timestamp + jump);
    _ok("env.warp");
  }

  /// @dev A griefer copies an owner's public digest into its own registry
  /// history and opens a decoy with it. The owner's pin must be untouched
  /// and the owner's secret must never verify on the decoy (I5, I6, Q3).
  function decoyOpen(uint256 idSeed) external {
    _op("adv.decoy");
    uint256 id = _pickId(idSeed);
    if (id == 0) return;
    ShieldVault.Position memory p = vault.positionOf(id);
    if (p.vetoDigest == bytes32(0) || vault.depositsPaused() || !vault.tokenSupported(address(p.token))) return;
    if (_pullBlocked(address(p.token), thief) || _netOf(address(p.token), 1) == 0) return;
    bytes32 d = p.vetoDigest;
    bool pinnedBefore = vault.digestPinned(p.owner, d);
    vm.prank(thief);
    uint256 index = registry.register(d, SCHEME_HASH_PREIMAGE, address(vault));
    vm.prank(thief);
    try vault.open(p.token, 1, _noFallback(uint32(7 days)), index, MAX_FEE_BPS) returns (uint256 decoy) {
      _ok("adv.decoy");
      _check(vault.digestPinned(p.owner, d) == pinnedBefore, "decoy: changed the owner's pin (I6)");
      _check(vault.positionOf(decoy).vetoDigest == d, "decoy: digest not stored");
      Sheet memory s = activeSheet[id];
      vm.prank(thief);
      try vault.veto(decoy, s.secret, s.recoveryTo) {
        _fail("decoy: the owner's secret vetoed the decoy (digest does not bind owner) (I5)");
      } catch {}
      ghostFeeAtOpen[decoy] = vault.positionOf(decoy).feeBps;
      ghostDigestsOf[decoy].push(d);
      ghostPinnedOf[thief].push(d);
      activeSheet[decoy] = Sheet(bytes32(0), address(0), NO_VETO);
    } catch {
      // the thief already pinned this digest once: CommitmentReused for the thief, fine
      _check(vault.digestPinned(thief, d), "decoy: open refused for a reason other than the thief's own reuse");
    }
  }

  /// @dev Arms the hostile token to call back into the vault on its next transfer.
  function armHostile(uint256 idSeed, uint8 which) external {
    _op("adv.armHostile");
    uint256 id = _pickId(idSeed);
    if (id == 0) id = 1;
    which = uint8(which % 9);
    bytes memory data;
    if (which == 0) data = abi.encodeCall(vault.deposit, (id, 1));
    else if (which == 1) data = abi.encodeCall(vault.executePending, (id));
    else if (which == 2) data = abi.encodeCall(vault.veto, (id, bytes32(0), thief));
    else if (which == 3) data = abi.encodeCall(vault.executeFallback, (id));
    else if (which == 4) data = abi.encodeCall(vault.claimOwed, (id, thief));
    else if (which == 5) data = abi.encodeCall(vault.collectFees, (IERC20(address(hostile))));
    else if (which == 6) data = abi.encodeCall(vault.checkIn, (id));
    else if (which == 7) data = abi.encodeCall(vault.requestWithdraw, (id, ALL, thief));
    else data = abi.encodeCall(vault.open, (IERC20(address(hostile)), 1, _noFallback(uint32(7 days)), NO_VETO, MAX_FEE_BPS));
    hostile.armOnce(address(vault), data);
    _ok("adv.armHostile");
  }
}
