// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {QuantumRecoveryRegistry} from "../common/QuantumRecoveryRegistry.sol";

/**
 * @title ShieldVault (v2)
 * @notice A delayed, inheritable, quantum-vetoable holding. Spec and threat
 * model: docs/plans/shield-vault.md.
 *
 * Funds leave a position in exactly three ways:
 *  - the owner requests a withdrawal to an address fixed at request time and
 *    waits the position's exit delay (`requestWithdraw` then
 *    `executePending`);
 *  - the owner stays silent for the position's silence period and the
 *    balance goes to the beneficiaries of the active config
 *    (`executeFallback`), each share paid at once or, for a beneficiary
 *    marked in `holdMask`, held until it claims with its signature
 *    (`claimOwedWithSig`, to a wallet of its choice);
 *  - someone presents the recovery secret, and the whole balance goes to
 *    the recovery wallet committed together with it (`veto`).
 *
 * Every owner-initiated change of where funds can go waits the exit delay
 * and can be vetoed meanwhile, so a stolen key only starts something the
 * owner can see and stop. The admin can only curate which tokens may be
 * deposited, pause new deposits, and set the fee for positions opened
 * later (never above `MAX_FEE_BPS`, never for an existing position); it
 * cannot touch a position. Exits are never pausable. Not upgradeable: a fix
 * is a new deployment, and every position can leave through its own delay.
 *
 * Permissionless: `executePending`, `veto`, `executeFallback`, `claimOwed`
 * and `collectFees` pay addresses fixed earlier; the `...WithSig` functions
 * act only on a signature of the owner or beneficiary. So anyone may submit
 * all of them (the gas relay).
 */
contract ShieldVault is Ownable2Step, ReentrancyGuardTransient, EIP712 {
  using SafeERC20 for IERC20;

  // ───────────── Constants ─────────────

  /// @dev Domain tag of the veto commitment; see `_vetoDigest`. v2 binds
  /// the owner, so a copied digest never verifies on another's position.
  bytes32 private constant VETO_TAG = keccak256("10102.ShieldVault.veto.v2");
  /// @dev QuantumRecoveryRegistry scheme label for a plain hash preimage.
  uint8 private constant SCHEME_HASH_PREIMAGE = 5;
  /// @dev Sentinel for "no veto commitment".
  uint256 public constant NO_VETO = type(uint256).max;
  /// @dev `requestWithdraw` amount meaning "the whole balance at execution",
  /// so a stranger's dust deposit cannot keep a closing position open.
  uint256 public constant ALL = type(uint256).max;

  uint256 private constant BPS = 10_000;
  uint256 public constant MAX_BENEFICIARIES = 10;
  /// @notice Hard ceiling of the exit fee: 0.5%.
  uint16 public constant MAX_FEE_BPS = 50;
  uint32 private constant MIN_SILENCE = 180 days;
  uint32 private constant MAX_SILENCE = 1095 days;

  bytes32 private constant CHECK_IN_TYPEHASH = keccak256("CheckIn(uint256 id,uint256 nonce,uint256 deadline)");
  bytes32 private constant CANCEL_TYPEHASH =
    keccak256("CancelPending(uint256 id,uint64 readyAt,uint256 nonce,uint256 deadline)");
  bytes32 private constant CLAIM_TYPEHASH =
    keccak256("ClaimOwed(uint256 id,address beneficiary,address to,uint256 nonce,uint256 deadline)");

  /// @notice Nonce purposes: each signed action has its own counter, so
  /// spending one (say a check-in) never voids another (a cancel or a
  /// claim) signed by the same key.
  uint8 public constant NONCE_CHECK_IN = 0;
  uint8 public constant NONCE_CANCEL = 1;
  uint8 public constant NONCE_CLAIM = 2;

  // ───────────── Types ─────────────

  /// @notice Where a position can go without its owner, and how slowly the
  /// owner can move it. `silencePeriod == 0` means no fallback. Bit `i` of
  /// `holdMask` holds beneficiary `i`'s share in `owed` at release instead
  /// of sending it (for a key kept on paper, whose address holds no ETH).
  struct Config {
    uint32 exitDelay;
    uint32 silencePeriod;
    address[] beneficiaries;
    uint16[] sharesBps;
    uint16 holdMask;
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
    /// @dev The fee rate when the position opened; later rate changes do
    /// not apply to it.
    uint16 feeBps;
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
  /// @notice Payouts not sent yet: a transfer that failed (a blacklisted
  /// payee, a paused token), or a share held for a `holdMask` beneficiary.
  /// Claimable by anyone for the payee, or by the payee's signature to any
  /// destination.
  mapping(uint256 id => mapping(address payee => uint256)) public owed;
  /// @notice Veto digests an owner has pinned. One recovery sheet protects
  /// one position of that owner: once a veto has revealed a secret, none of
  /// the owner's other positions may still rely on it. Per owner, so no one
  /// else can pin (and so burn) an owner's freshly registered digest; and
  /// the digest itself binds the owner, so a copy pinned by someone else
  /// never verifies there.
  mapping(address owner => mapping(bytes32 digest => bool)) public digestPinned;
  /// @notice Signed-action nonces, per signer and purpose (NONCE_*).
  mapping(address signer => mapping(uint8 purpose => uint256)) public nonces;

  mapping(address token => bool) public tokenSupported;
  bool public depositsPaused;

  /// @notice Fee rate for positions opened from now on, in basis points.
  uint16 public feeBps;
  address public feeRecipient;
  /// @notice Fees taken and not yet sent to `feeRecipient`.
  mapping(address token => uint256) public feesAccrued;

  // ───────────── Events ─────────────

  /// @dev Carries the pinned veto digest (zero without a sheet), so a
  /// client holding only the sheet can find the position from the logs.
  event PositionOpened(
    uint256 indexed id,
    address indexed owner,
    address indexed token,
    uint32 exitDelay,
    uint32 silencePeriod,
    bytes32 vetoDigest,
    uint16 feeBps
  );
  event Deposited(uint256 indexed id, address indexed from, uint256 amount);
  event CheckedIn(uint256 indexed id, uint64 at);
  event WithdrawRequested(uint256 indexed id, address indexed to, uint256 amount, uint64 readyAt);
  /// @dev Carries the new digest and a hash of the new beneficiary list
  /// (with shares and hold mask) so an alert can say exactly what is
  /// changing (a swapped commitment with identical people is the thief's
  /// quiet move).
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
  event FeeCharged(uint256 indexed id, address indexed token, uint256 amount);
  /// @dev A failed transfer, kept for the payee.
  event OwedRecorded(uint256 indexed id, address indexed beneficiary, uint256 amount);
  /// @dev A `holdMask` share, kept for its card's signed claim.
  event ShareHeld(uint256 indexed id, address indexed beneficiary, uint256 amount);
  event OwedClaimed(uint256 indexed id, address indexed beneficiary, address indexed to, uint256 amount);
  event TokenSupportSet(address indexed token, bool supported);
  event DepositsPausedSet(bool paused);
  event FeeSet(uint16 feeBps);
  event FeeRecipientSet(address indexed recipient);
  event FeesCollected(address indexed token, address indexed to, uint256 amount);

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
  error FeeTooHigh();
  error SignatureExpired();
  error InvalidSignature();
  error ShareIsHeld();

  constructor(
    QuantumRecoveryRegistry registry_,
    address initialOwner,
    address[] memory tokens,
    address feeRecipient_,
    uint16 feeBps_
  ) Ownable(initialOwner) EIP712("10102 ShieldVault", "2") {
    if (address(registry_) == address(0)) revert InvalidAddress();
    registry = registry_;
    for (uint256 i = 0; i < tokens.length; i++) {
      _setTokenSupported(tokens[i], true);
    }
    _setFeeRecipient(feeRecipient_);
    _setFee(feeBps_);
  }

  // ───────────── Admin (curation and future fee only) ─────────────

  function setTokenSupported(address token, bool supported) external onlyOwner {
    _setTokenSupported(token, supported);
  }

  function setDepositsPaused(bool paused) external onlyOwner {
    depositsPaused = paused;
    emit DepositsPausedSet(paused);
  }

  /// @notice The fee for positions opened from now on. Existing positions
  /// keep the rate they opened with.
  function setFee(uint16 bps) external onlyOwner {
    _setFee(bps);
  }

  function setFeeRecipient(address recipient) external onlyOwner {
    _setFeeRecipient(recipient);
  }

  /// @notice Send the fees taken in `token` to `feeRecipient`. Anyone may
  /// call; fees never sit in the path of an exit.
  function collectFees(IERC20 token) external nonReentrant {
    uint256 amount = feesAccrued[address(token)];
    if (amount == 0) revert NothingOwed();
    feesAccrued[address(token)] = 0;
    address to = feeRecipient;
    emit FeesCollected(address(token), to, amount);
    token.safeTransfer(to, amount);
  }

  // ───────────── Owner flows ─────────────

  /// @notice Open a position with `amount` of `token`. `vetoIndex` names a
  /// scheme-5 commitment of the caller in the registry, or `NO_VETO`.
  /// `maxFeeBps` is the highest fee the caller accepts: a rate raised
  /// between signing and inclusion makes the open revert instead of binding.
  function open(
    IERC20 token,
    uint256 amount,
    Config calldata config,
    uint256 vetoIndex,
    uint16 maxFeeBps
  ) external nonReentrant returns (uint256 id) {
    if (feeBps > maxFeeBps) revert FeeTooHigh();
    _validateConfig(config);
    bytes32 digest = _pinCommitment(msg.sender, vetoIndex, bytes32(0));

    id = ++positionCount;
    Position storage p = _positions[id];
    p.owner = msg.sender;
    p.token = token;
    p.vetoDigest = digest;
    p.feeBps = feeBps;
    p.lastActivity = uint64(block.timestamp);
    _storeConfig(p.config, config);
    _ownerPositions[msg.sender].push(id);

    emit PositionOpened(id, msg.sender, address(token), config.exitDelay, config.silencePeriod, digest, p.feeBps);
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

  /// @notice A check-in signed by the owner and submitted by anyone (the
  /// relay pays the gas). Owners may be contracts (ERC-1271).
  function checkInWithSig(uint256 id, uint256 deadline, bytes calldata signature) external {
    Position storage p = _open(id);
    _verify(
      p.owner,
      keccak256(abi.encode(CHECK_IN_TYPEHASH, id, _useNonce(p.owner, NONCE_CHECK_IN), deadline)),
      deadline,
      signature
    );
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
      keccak256(abi.encode(config.beneficiaries, config.sharesBps, config.holdMask)),
      readyAt
    );
  }

  function cancelPending(uint256 id) external {
    Position storage p = _ownedOpen(id);
    _cancel(id, p);
  }

  /// @notice A cancel signed by the owner and submitted by anyone, so an
  /// owner whose wallet was emptied of ETH can still stop a withdrawal.
  /// Bound to the pending operation's `readyAt`: a signature made for one
  /// operation cannot cancel a later one.
  function cancelPendingWithSig(uint256 id, uint256 deadline, bytes calldata signature) external {
    Position storage p = _open(id);
    if (p.pending.kind == PendingKind.None) revert NothingPending();
    _verify(
      p.owner,
      keccak256(abi.encode(CANCEL_TYPEHASH, id, p.pending.readyAt, _useNonce(p.owner, NONCE_CANCEL), deadline)),
      deadline,
      signature
    );
    _cancel(id, p);
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
      uint256 net = amount - _takeFee(id, p, amount);
      emit Withdrawn(id, to, net);
      // A payee that cannot receive (blacklisted since the request) must
      // not freeze the position: the owner may be gone and unable to
      // cancel, and a stuck pending slot would block the fallback forever.
      _payOrOwe(id, p.token, to, net);
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
  /// secret can only ever send the funds where the owner said. Free of fee.
  /// If the transfer fails (a paused token, a blacklisted recovery wallet),
  /// the amount is owed to the recovery wallet: the stop itself never fails.
  function veto(uint256 id, bytes32 secret, address recoveryTo) external nonReentrant {
    Position storage p = _open(id);
    bytes32 pinned = p.vetoDigest;
    if (pinned == bytes32(0)) revert NoVeto();
    if (recoveryTo == address(0) || recoveryTo == address(this)) revert InvalidAddress();
    if (_vetoDigest(p.owner, secret, recoveryTo) != pinned) revert WrongSecret();

    uint256 amount = p.balance;
    p.balance = 0;
    p.closed = true;
    delete p.pending;
    emit Vetoed(id, recoveryTo, amount);
    if (amount > 0) _payOrOwe(id, p.token, recoveryTo, amount);
  }

  /// @notice After the silence period, pay every beneficiary its share
  /// (after the position's fee). A `holdMask` share, or a transfer that
  /// fails, is recorded as owed and does not block the others.
  function executeFallback(uint256 id) external nonReentrant {
    Position storage p = _open(id);
    uint32 silence = p.config.silencePeriod;
    if (silence == 0) revert NoFallback();
    if (p.pending.kind != PendingKind.None) revert PendingExists();
    if (block.timestamp < uint256(p.lastActivity) + silence) revert OwnerStillActive();

    uint256 gross = p.balance;
    p.balance = 0;
    p.closed = true;
    uint256 total = gross - _takeFee(id, p, gross);
    emit FallbackExecuted(id, total);

    address[] storage bens = p.config.beneficiaries;
    uint16[] storage shares = p.config.sharesBps;
    uint16 hold = p.config.holdMask;
    uint256 n = bens.length;
    uint256 paid;
    for (uint256 i = 0; i < n; i++) {
      // The last beneficiary takes the rounding remainder, so exactly
      // `total` leaves the position.
      uint256 amount = i == n - 1 ? total - paid : (total * shares[i]) / BPS;
      paid += amount;
      if (amount == 0) continue;
      if ((uint256(hold) >> i) & 1 == 1) {
        owed[id][bens[i]] += amount;
        emit ShareHeld(id, bens[i], amount);
      } else {
        _payOrOwe(id, p.token, bens[i], amount);
      }
    }
  }

  /// @notice Pay an owed amount to its payee. A held share for a key with
  /// no code (a printed card, which cannot pay gas) moves only on the
  /// payee's own call or signature, so no one can push it onto the card's
  /// address. A contract payee can always be paid directly, so it is never
  /// gated (a contract that cannot sign or call would otherwise be locked).
  function claimOwed(uint256 id, address beneficiary) external nonReentrant {
    if (msg.sender != beneficiary && beneficiary.code.length == 0 && _isHeld(id, beneficiary)) revert ShareIsHeld();
    _claimOwed(id, beneficiary, beneficiary);
  }

  /// @notice Pay an owed amount to `to`, on the payee's signature (a key
  /// kept on paper needs no ETH: anyone submits it).
  function claimOwedWithSig(
    uint256 id,
    address beneficiary,
    address to,
    uint256 deadline,
    bytes calldata signature
  ) external nonReentrant {
    if (to == address(0) || to == address(this)) revert InvalidAddress();
    _verify(
      beneficiary,
      keccak256(abi.encode(CLAIM_TYPEHASH, id, beneficiary, to, _useNonce(beneficiary, NONCE_CLAIM), deadline)),
      deadline,
      signature
    );
    _claimOwed(id, beneficiary, to);
  }

  // ───────────── Views ─────────────

  function positionOf(uint256 id) external view returns (Position memory) {
    if (_positions[id].owner == address(0)) revert UnknownPosition();
    return _positions[id];
  }

  function positionsOf(address owner) external view returns (uint256[] memory) {
    return _ownerPositions[owner];
  }

  /// @notice When the fallback becomes executable: 0 when the position is
  /// unknown, closed, or has none. A pending operation must be executed
  /// first, so the result is never before its `readyAt`; a pending change
  /// is judged by the silence period it would install.
  function fallbackAvailableAt(uint256 id) external view returns (uint256) {
    Position storage p = _positions[id];
    if (p.owner == address(0) || p.closed) return 0;
    PendingKind kind = p.pending.kind;
    uint32 silence = kind == PendingKind.Change ? p.pending.config.silencePeriod : p.config.silencePeriod;
    if (silence == 0) return 0;
    uint256 at = uint256(p.lastActivity) + silence;
    uint256 ready = p.pending.readyAt;
    return kind != PendingKind.None && ready > at ? ready : at;
  }

  /// @notice EIP-712 domain separator of the signed actions.
  function domainSeparator() external view returns (bytes32) {
    return _domainSeparatorV4();
  }

  // ───────────── Internals ─────────────

  /// @dev Clients compute this locally; never send the secret to an RPC.
  function _vetoDigest(address owner, bytes32 secret, address recoveryTo) private view returns (bytes32) {
    return keccak256(abi.encode(VETO_TAG, block.chainid, address(this), owner, secret, recoveryTo));
  }

  function _useNonce(address signer, uint8 purpose) private returns (uint256) {
    unchecked {
      return nonces[signer][purpose]++;
    }
  }

  /// @dev Whether `who` is a `holdMask` beneficiary of the position's config.
  function _isHeld(uint256 id, address who) private view returns (bool) {
    Config storage c = _positions[id].config;
    if (c.holdMask == 0) return false;
    uint256 n = c.beneficiaries.length;
    for (uint256 i = 0; i < n; i++) {
      if (c.beneficiaries[i] == who) return (uint256(c.holdMask) >> i) & 1 == 1;
    }
    return false;
  }

  function _verify(address signer, bytes32 structHash, uint256 deadline, bytes calldata signature) private view {
    if (block.timestamp > deadline) revert SignatureExpired();
    if (!SignatureChecker.isValidSignatureNow(signer, _hashTypedDataV4(structHash), signature)) revert InvalidSignature();
  }

  /// @dev Reads the owner's scheme-5 commitment at `index` and marks its
  /// digest as used for that owner. `keep` is the position's current
  /// digest: re-pinning it in a config change is allowed, any other digest
  /// the owner pinned before is not (one recovery sheet, one position).
  function _pinCommitment(address owner, uint256 index, bytes32 keep) private returns (bytes32) {
    if (index == NO_VETO) return bytes32(0);
    QuantumRecoveryRegistry.Commitment memory c = registry.commitmentAt(owner, index);
    if (c.scheme != SCHEME_HASH_PREIMAGE) revert InvalidCommitment();
    if (c.digest == keep) return c.digest;
    if (digestPinned[owner][c.digest]) revert CommitmentReused();
    digestPinned[owner][c.digest] = true;
    return c.digest;
  }

  function _cancel(uint256 id, Position storage p) private {
    if (p.pending.kind == PendingKind.None) revert NothingPending();
    _touch(id, p);
    delete p.pending;
    emit PendingCancelled(id);
  }

  /// @dev Moves the position's fee on `amount` to `feesAccrued`.
  function _takeFee(uint256 id, Position storage p, uint256 amount) private returns (uint256 fee) {
    fee = (amount * p.feeBps) / BPS;
    if (fee > 0) {
      feesAccrued[address(p.token)] += fee;
      emit FeeCharged(id, address(p.token), fee);
    }
  }

  function _payOrOwe(uint256 id, IERC20 token, address to, uint256 amount) private {
    if (!token.trySafeTransfer(to, amount)) {
      owed[id][to] += amount;
      emit OwedRecorded(id, to, amount);
    }
  }

  function _claimOwed(uint256 id, address beneficiary, address to) private {
    uint256 amount = owed[id][beneficiary];
    if (amount == 0) revert NothingOwed();
    owed[id][beneficiary] = 0;
    emit OwedClaimed(id, beneficiary, to, amount);
    _positions[id].token.safeTransfer(to, amount);
  }

  function _validateConfig(Config calldata c) private view {
    if (c.exitDelay != 7 days && c.exitDelay != 30 days && c.exitDelay != 90 days) revert InvalidDelay();
    uint256 n = c.beneficiaries.length;
    if (n != c.sharesBps.length) revert InvalidBeneficiaries();
    if (c.silencePeriod == 0) {
      if (n != 0 || c.holdMask != 0) revert InvalidBeneficiaries();
      return;
    }
    if (c.silencePeriod < MIN_SILENCE || c.silencePeriod > MAX_SILENCE) revert InvalidSilence();
    if (n == 0 || n > MAX_BENEFICIARIES) revert InvalidBeneficiaries();
    if (c.holdMask >> n != 0) revert InvalidBeneficiaries();
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
    dst.holdMask = src.holdMask;
  }

  function _copyConfig(Config storage dst, Config storage src) private {
    dst.exitDelay = src.exitDelay;
    dst.silencePeriod = src.silencePeriod;
    dst.beneficiaries = src.beneficiaries;
    dst.sharesBps = src.sharesBps;
    dst.holdMask = src.holdMask;
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

  function _setFee(uint16 bps) private {
    if (bps > MAX_FEE_BPS) revert FeeTooHigh();
    feeBps = bps;
    emit FeeSet(bps);
  }

  function _setFeeRecipient(address recipient) private {
    if (recipient == address(0) || recipient == address(this)) revert InvalidAddress();
    feeRecipient = recipient;
    emit FeeRecipientSet(recipient);
  }
}
