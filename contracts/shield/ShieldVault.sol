// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {QuantumRecoveryRegistry} from "../common/QuantumRecoveryRegistry.sol";

/**
 * @title ShieldVault
 * @notice A delayed, inheritable, quantum-vetoable holding. Spec and threat
 * model: docs/plans/shield-vault.md.
 *
 * Funds leave a position in exactly three ways:
 *  - the owner requests a withdrawal to an address fixed at request time and
 *    waits the position's exit delay (`requestWithdraw` then
 *    `executePending`);
 *  - the owner stays silent for the position's silence period and the
 *    balance goes to the beneficiaries of the active config
 *    (`executeFallback`);
 *  - someone presents the recovery secret, and the whole balance goes to
 *    the recovery wallet committed together with it (`veto`).
 *
 * Every owner-initiated change of where funds can go waits the exit delay
 * and can be vetoed meanwhile, so a stolen key only starts something the
 * owner can see and stop. The admin can only curate which tokens may be
 * deposited and pause new deposits; it cannot touch a position. Exits are
 * never pausable. Not upgradeable: a fix is a new deployment, and every
 * position can leave through its own delay.
 *
 * `executePending`, `veto`, `executeFallback` and `claimOwed` pay
 * addresses fixed earlier, so anyone may submit them (the gas relay).
 */
contract ShieldVault is Ownable2Step, ReentrancyGuardTransient {
  using SafeERC20 for IERC20;

  // ───────────── Constants ─────────────

  /// @dev Domain tag of the veto commitment; see `_vetoDigest`.
  bytes32 private constant VETO_TAG = keccak256("10102.ShieldVault.veto.v1");
  /// @dev QuantumRecoveryRegistry scheme label for a plain hash preimage.
  uint8 private constant SCHEME_HASH_PREIMAGE = 5;
  /// @dev Sentinel for "no veto commitment".
  uint256 public constant NO_VETO = type(uint256).max;
  /// @dev `requestWithdraw` amount meaning "the whole balance at execution",
  /// so a stranger's dust deposit cannot keep a closing position open.
  uint256 public constant ALL = type(uint256).max;

  uint256 private constant BPS = 10_000;
  uint256 public constant MAX_BENEFICIARIES = 10;
  uint32 private constant MIN_SILENCE = 180 days;
  uint32 private constant MAX_SILENCE = 1095 days;

  // ───────────── Types ─────────────

  /// @notice Where a position can go without its owner, and how slowly the
  /// owner can move it. `silencePeriod == 0` means no fallback.
  struct Config {
    uint32 exitDelay;
    uint32 silencePeriod;
    address[] beneficiaries;
    uint16[] sharesBps;
  }

  enum PendingKind {
    None,
    Withdraw,
    Change
  }

  struct Pending {
    PendingKind kind;
    uint64 readyAt;
    uint256 amount; // Withdraw
    address to; // Withdraw
    Config config; // Change
    bytes32 vetoDigest; // Change
  }

  struct Position {
    address owner;
    uint64 lastActivity;
    bool closed;
    IERC20 token;
    uint256 balance;
    bytes32 vetoDigest;
    Config config;
    Pending pending;
  }

  // ───────────── Storage ─────────────

  QuantumRecoveryRegistry public immutable registry;

  uint256 public positionCount;
  mapping(uint256 id => Position) private _positions;
  mapping(address owner => uint256[]) private _ownerPositions;
  /// @notice Payouts whose transfer failed (a blacklisted fallback
  /// beneficiary or withdrawal address), claimable later by anyone for
  /// that payee.
  mapping(uint256 id => mapping(address payee => uint256)) public owed;
  /// @notice Veto digests ever pinned. One recovery sheet protects one
  /// position: once a veto has revealed a secret, no other position may
  /// still rely on it.
  mapping(bytes32 digest => bool) public digestPinned;

  mapping(address token => bool) public tokenSupported;
  bool public depositsPaused;

  // ───────────── Events ─────────────

  event PositionOpened(uint256 indexed id, address indexed owner, address indexed token, uint32 exitDelay, uint32 silencePeriod, bool vetoArmed);
  event Deposited(uint256 indexed id, address indexed from, uint256 amount);
  event CheckedIn(uint256 indexed id, uint64 at);
  event WithdrawRequested(uint256 indexed id, address indexed to, uint256 amount, uint64 readyAt);
  /// @dev Carries the new digest and a hash of the new beneficiary list so
  /// an alert can say exactly what is changing (a swapped commitment with
  /// identical people is the thief's quiet move).
  event ChangeRequested(
    uint256 indexed id,
    uint32 exitDelay,
    uint32 silencePeriod,
    bytes32 newVetoDigest,
    bytes32 beneficiariesHash,
    uint64 readyAt
  );
  event PendingCancelled(uint256 indexed id);
  event Withdrawn(uint256 indexed id, address indexed to, uint256 amount);
  event ChangeApplied(uint256 indexed id);
  event Vetoed(uint256 indexed id, address indexed recoveryTo, uint256 amount);
  event FallbackExecuted(uint256 indexed id, uint256 amount);
  event OwedRecorded(uint256 indexed id, address indexed beneficiary, uint256 amount);
  event OwedClaimed(uint256 indexed id, address indexed beneficiary, uint256 amount);
  event TokenSupportSet(address indexed token, bool supported);
  event DepositsPausedSet(bool paused);

  // ───────────── Errors ─────────────

  error NotOwner();
  error PositionClosed();
  error UnknownPosition();
  error TokenNotSupported();
  error DepositsPaused();
  error ZeroAmount();
  error NothingReceived();
  error InvalidDelay();
  error InvalidSilence();
  error InvalidBeneficiaries();
  error InvalidAddress();
  error InvalidCommitment();
  error PendingExists();
  error NothingPending();
  error NotReady();
  error InsufficientBalance();
  error NoVeto();
  error WrongSecret();
  error NoFallback();
  error OwnerStillActive();
  error NothingOwed();
  error CommitmentReused();

  constructor(QuantumRecoveryRegistry registry_, address initialOwner, address[] memory tokens) Ownable(initialOwner) {
    if (address(registry_) == address(0)) revert InvalidAddress();
    registry = registry_;
    for (uint256 i = 0; i < tokens.length; i++) {
      _setTokenSupported(tokens[i], true);
    }
  }

  // ───────────── Admin (curation only) ─────────────

  function setTokenSupported(address token, bool supported) external onlyOwner {
    _setTokenSupported(token, supported);
  }

  function setDepositsPaused(bool paused) external onlyOwner {
    depositsPaused = paused;
    emit DepositsPausedSet(paused);
  }

  // ───────────── Owner flows ─────────────

  /// @notice Open a position with `amount` of `token`. `vetoIndex` names a
  /// scheme-5 commitment of the caller in the registry, or `NO_VETO`.
  function open(IERC20 token, uint256 amount, Config calldata config, uint256 vetoIndex) external nonReentrant returns (uint256 id) {
    _validateConfig(config);
    bytes32 digest = _pinCommitment(msg.sender, vetoIndex, bytes32(0));

    id = ++positionCount;
    Position storage p = _positions[id];
    p.owner = msg.sender;
    p.token = token;
    p.vetoDigest = digest;
    p.lastActivity = uint64(block.timestamp);
    _storeConfig(p.config, config);
    _ownerPositions[msg.sender].push(id);

    emit PositionOpened(id, msg.sender, address(token), config.exitDelay, config.silencePeriod, digest != bytes32(0));
    _pull(id, p, amount);
  }

  /// @notice Top up a position. Anyone may add; only the owner counts as
  /// activity.
  function deposit(uint256 id, uint256 amount) external nonReentrant {
    Position storage p = _open(id);
    if (msg.sender == p.owner) _touch(id, p);
    _pull(id, p, amount);
  }

  function checkIn(uint256 id) external {
    Position storage p = _ownedOpen(id);
    _touch(id, p);
  }

  /// @notice Start a withdrawal of `amount` (or `ALL`) to `to`, executable
  /// after the exit delay. `ALL` resolves at execution and closes the
  /// position.
  function requestWithdraw(uint256 id, uint256 amount, address to) external {
    Position storage p = _ownedOpen(id);
    if (p.pending.kind != PendingKind.None) revert PendingExists();
    if (amount == 0) revert ZeroAmount();
    if (amount != ALL && amount > p.balance) revert InsufficientBalance();
    if (to == address(0) || to == address(this)) revert InvalidAddress();
    _touch(id, p);

    uint64 readyAt = uint64(block.timestamp) + p.config.exitDelay;
    p.pending.kind = PendingKind.Withdraw;
    p.pending.readyAt = readyAt;
    p.pending.amount = amount;
    p.pending.to = to;
    emit WithdrawRequested(id, to, amount, readyAt);
  }

  /// @notice Start a change of config and veto commitment, applied after
  /// the CURRENT exit delay. The new commitment is pinned now, so a
  /// substitution is visible for the whole wait and vetoable with the old
  /// secret.
  function requestChange(uint256 id, Config calldata config, uint256 vetoIndex) external {
    Position storage p = _ownedOpen(id);
    if (p.pending.kind != PendingKind.None) revert PendingExists();
    _validateConfig(config);
    bytes32 digest = _pinCommitment(msg.sender, vetoIndex, p.vetoDigest);
    _touch(id, p);

    uint64 readyAt = uint64(block.timestamp) + p.config.exitDelay;
    p.pending.kind = PendingKind.Change;
    p.pending.readyAt = readyAt;
    p.pending.vetoDigest = digest;
    _storeConfig(p.pending.config, config);
    emit ChangeRequested(
      id,
      config.exitDelay,
      config.silencePeriod,
      digest,
      keccak256(abi.encode(config.beneficiaries, config.sharesBps)),
      readyAt
    );
  }

  function cancelPending(uint256 id) external {
    Position storage p = _ownedOpen(id);
    if (p.pending.kind == PendingKind.None) revert NothingPending();
    _touch(id, p);
    delete p.pending;
    emit PendingCancelled(id);
  }

  // ───────────── Permissionless exits ─────────────

  /// @notice Finish a pending withdrawal or change once its delay passed.
  function executePending(uint256 id) external nonReentrant {
    Position storage p = _open(id);
    PendingKind kind = p.pending.kind;
    if (kind == PendingKind.None) revert NothingPending();
    if (block.timestamp < p.pending.readyAt) revert NotReady();

    if (kind == PendingKind.Withdraw) {
      uint256 amount = p.pending.amount == ALL ? p.balance : p.pending.amount;
      address to = p.pending.to;
      delete p.pending;
      p.balance -= amount;
      if (p.balance == 0) p.closed = true;
      emit Withdrawn(id, to, amount);
      // A payee that cannot receive (blacklisted since the request) must
      // not freeze the position: the owner may be gone and unable to
      // cancel, and a stuck pending slot would block the fallback forever.
      if (!p.token.trySafeTransfer(to, amount)) {
        owed[id][to] += amount;
        emit OwedRecorded(id, to, amount);
      }
    } else {
      p.vetoDigest = p.pending.vetoDigest;
      _copyConfig(p.config, p.pending.config);
      delete p.pending;
      emit ChangeApplied(id);
    }
  }

  /// @notice Move the whole position to the recovery wallet committed with
  /// `secret`. Works at any time; clears anything pending and closes the
  /// position. The destination is part of the commitment, so a copied
  /// secret can only ever send the funds where the owner said.
  function veto(uint256 id, bytes32 secret, address recoveryTo) external nonReentrant {
    Position storage p = _open(id);
    bytes32 pinned = p.vetoDigest;
    if (pinned == bytes32(0)) revert NoVeto();
    if (recoveryTo == address(0) || recoveryTo == address(this)) revert InvalidAddress();
    if (_vetoDigest(secret, recoveryTo) != pinned) revert WrongSecret();

    uint256 amount = p.balance;
    p.balance = 0;
    p.closed = true;
    delete p.pending;
    emit Vetoed(id, recoveryTo, amount);
    if (amount > 0) p.token.safeTransfer(recoveryTo, amount);
  }

  /// @notice After the silence period, pay every beneficiary its share. A
  /// transfer that fails (blacklist, reverting receiver) is recorded as owed
  /// and does not block the others.
  function executeFallback(uint256 id) external nonReentrant {
    Position storage p = _open(id);
    uint32 silence = p.config.silencePeriod;
    if (silence == 0) revert NoFallback();
    if (p.pending.kind != PendingKind.None) revert PendingExists();
    if (block.timestamp < uint256(p.lastActivity) + silence) revert OwnerStillActive();

    uint256 total = p.balance;
    p.balance = 0;
    p.closed = true;
    emit FallbackExecuted(id, total);

    address[] storage bens = p.config.beneficiaries;
    uint16[] storage shares = p.config.sharesBps;
    uint256 n = bens.length;
    uint256 paid;
    for (uint256 i = 0; i < n; i++) {
      // The last beneficiary takes the rounding remainder, so exactly
      // `total` leaves the position.
      uint256 amount = i == n - 1 ? total - paid : (total * shares[i]) / BPS;
      paid += amount;
      if (amount == 0) continue;
      if (!p.token.trySafeTransfer(bens[i], amount)) {
        owed[id][bens[i]] += amount;
        emit OwedRecorded(id, bens[i], amount);
      }
    }
  }

  /// @notice Retry an owed fallback share.
  function claimOwed(uint256 id, address beneficiary) external nonReentrant {
    uint256 amount = owed[id][beneficiary];
    if (amount == 0) revert NothingOwed();
    owed[id][beneficiary] = 0;
    emit OwedClaimed(id, beneficiary, amount);
    _positions[id].token.safeTransfer(beneficiary, amount);
  }

  // ───────────── Views ─────────────

  function positionOf(uint256 id) external view returns (Position memory) {
    if (_positions[id].owner == address(0)) revert UnknownPosition();
    return _positions[id];
  }

  function positionsOf(address owner) external view returns (uint256[] memory) {
    return _ownerPositions[owner];
  }

  /// @notice When the fallback becomes executable (0 when it has none). A
  /// pending operation must be executed first; the result is then the
  /// later of this time and the pending `readyAt`.
  function fallbackAvailableAt(uint256 id) external view returns (uint256) {
    Position storage p = _positions[id];
    if (p.config.silencePeriod == 0) return 0;
    uint256 at = uint256(p.lastActivity) + p.config.silencePeriod;
    uint256 ready = p.pending.readyAt;
    return p.pending.kind != PendingKind.None && ready > at ? ready : at;
  }

  // ───────────── Internals ─────────────

  /// @dev Clients compute this locally; never send the secret to an RPC.
  function _vetoDigest(bytes32 secret, address recoveryTo) private view returns (bytes32) {
    return keccak256(abi.encode(VETO_TAG, block.chainid, address(this), secret, recoveryTo));
  }

  /// @dev Reads the caller's scheme-5 commitment at `index` and marks its
  /// digest as used. `keep` is the position's current digest: re-pinning it
  /// in a config change is allowed, any other previously pinned digest is
  /// not (one recovery sheet, one position).
  function _pinCommitment(address owner, uint256 index, bytes32 keep) private returns (bytes32) {
    if (index == NO_VETO) return bytes32(0);
    QuantumRecoveryRegistry.Commitment memory c = registry.commitmentAt(owner, index);
    if (c.scheme != SCHEME_HASH_PREIMAGE) revert InvalidCommitment();
    if (c.digest == keep) return c.digest;
    if (digestPinned[c.digest]) revert CommitmentReused();
    digestPinned[c.digest] = true;
    return c.digest;
  }

  function _validateConfig(Config calldata c) private view {
    if (c.exitDelay != 7 days && c.exitDelay != 30 days && c.exitDelay != 90 days) revert InvalidDelay();
    uint256 n = c.beneficiaries.length;
    if (n != c.sharesBps.length) revert InvalidBeneficiaries();
    if (c.silencePeriod == 0) {
      if (n != 0) revert InvalidBeneficiaries();
      return;
    }
    if (c.silencePeriod < MIN_SILENCE || c.silencePeriod > MAX_SILENCE) revert InvalidSilence();
    if (n == 0 || n > MAX_BENEFICIARIES) revert InvalidBeneficiaries();
    uint256 sum;
    for (uint256 i = 0; i < n; i++) {
      address b = c.beneficiaries[i];
      if (b == address(0) || b == address(this)) revert InvalidBeneficiaries();
      for (uint256 j = 0; j < i; j++) {
        if (c.beneficiaries[j] == b) revert InvalidBeneficiaries();
      }
      if (c.sharesBps[i] == 0) revert InvalidBeneficiaries();
      sum += c.sharesBps[i];
    }
    if (sum != BPS) revert InvalidBeneficiaries();
  }

  function _storeConfig(Config storage dst, Config calldata src) private {
    dst.exitDelay = src.exitDelay;
    dst.silencePeriod = src.silencePeriod;
    dst.beneficiaries = src.beneficiaries;
    dst.sharesBps = src.sharesBps;
  }

  function _copyConfig(Config storage dst, Config storage src) private {
    dst.exitDelay = src.exitDelay;
    dst.silencePeriod = src.silencePeriod;
    dst.beneficiaries = src.beneficiaries;
    dst.sharesBps = src.sharesBps;
  }

  /// @dev Credit what actually arrived, so fee-on-transfer tokens cannot
  /// inflate a position.
  function _pull(uint256 id, Position storage p, uint256 amount) private {
    if (depositsPaused) revert DepositsPaused();
    if (!tokenSupported[address(p.token)]) revert TokenNotSupported();
    if (amount == 0) revert ZeroAmount();
    uint256 before = p.token.balanceOf(address(this));
    p.token.safeTransferFrom(msg.sender, address(this), amount);
    uint256 received = p.token.balanceOf(address(this)) - before;
    if (received == 0) revert NothingReceived();
    p.balance += received;
    emit Deposited(id, msg.sender, received);
  }

  function _touch(uint256 id, Position storage p) private {
    uint64 nowTs = uint64(block.timestamp);
    p.lastActivity = nowTs;
    emit CheckedIn(id, nowTs);
  }

  function _open(uint256 id) private view returns (Position storage p) {
    p = _positions[id];
    if (p.owner == address(0)) revert UnknownPosition();
    if (p.closed) revert PositionClosed();
  }

  function _ownedOpen(uint256 id) private view returns (Position storage p) {
    p = _open(id);
    if (msg.sender != p.owner) revert NotOwner();
  }

  function _setTokenSupported(address token, bool supported) private {
    if (token == address(0)) revert InvalidAddress();
    tokenSupported[token] = supported;
    emit TokenSupportSet(token, supported);
  }
}
