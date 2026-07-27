// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract EIP712LegacyVerifier is Initializable, ReentrancyGuard, OwnableUpgradeable {
  struct Legacy {
    address legacyAddress;
    uint256 timestamp;
    bytes signature;
  }

  mapping(address => Legacy[]) public legacySigned;
  address public transferLegacyEOA;
  address public transferLegacy;
  address public multisigLegacy;
  mapping(bytes => uint256) signatureUsed;

  // ── Versioned terms acceptance (deferred item `legacy-tos-version`) ──
  // APPENDED storage (upgrade-safe): binds each consent record to the exact
  // ToS document in force at signing, not just who/when. The owner publishes
  // the active terms as a short human-readable version tag (goes inside the
  // signed message) plus the keccak256 hash of the full ToS document text
  // (stays on-chain, linking tag -> exact document).
  string public activeTermsVersion;
  bytes32 public activeTermsHash;
  /// @dev ToS document hash snapshotted per consent signature (the signature
  /// bytes are unique — enforced by `signatureUsed`). Zero for records made
  /// before terms versioning was activated or via the legacy message format.
  mapping(bytes => bytes32) public signatureTermsHash;
  /// @dev Version tag by document hash — lets views reconstruct the exact
  /// historical message a record was signed over even after the active
  /// terms move on. One-time write per published terms version.
  mapping(bytes32 => string) public termsVersionOf;

  // ── Tx-based consent registry (deferred item `timelock-consent-parity`) ──
  // APPENDED storage (upgrade-safe). Second consent modality alongside the
  // signed-message path above: for actions where the consenting party IS the
  // transaction signer (EOA creates with the in-form checkbox, gift-timelock
  // creates), the transaction signature itself is the cryptographic
  // attribution — the authorized router records "msg.sender accepted the
  // active terms (hash H, version V) at time T" with no separate wallet
  // popup. The signed-message path remains for flows where msg.sender is not
  // the consenting party (Safe-based legacies, future sponsored creates).

  /// @dev Contracts allowed to record tx-based consent (the routers). The
  /// legacy `onlyRouter` trio is not reused because this registry must cover
  /// the timelock router too, and be extensible without another upgrade.
  mapping(address => bool) public consentRecorders;

  struct Consent {
    bytes32 termsHash;
    uint64 timestamp;
    address recorder;
    uint256 refId;
  }

  /// @dev Per-user append-only consent log (tx-based modality only; the
  /// signed-message modality keeps using `legacySigned`).
  mapping(address => Consent[]) public userConsents;

  event LegacySigned(address indexed user, uint256 legacyId, uint256 timestamp);
  /// @dev Emitted alongside LegacySigned when the consent bound a specific
  /// terms version. Kept as a separate additive event so existing indexers
  /// are untouched.
  event LegacySignedVersioned(address indexed user, uint256 legacyId, uint256 timestamp, string termsVersion, bytes32 termsHash);
  event ActiveTermsUpdated(string termsVersion, bytes32 termsHash);
  /// @dev Tx-based consent record. `refId` is recorder-scoped context (the
  /// legacy id for the EOA router, the timelock id for the timelock router).
  event ConsentRecorded(
    address indexed user,
    bytes32 indexed termsHash,
    address indexed recorder,
    uint256 refId,
    string termsVersion,
    uint256 timestamp
  );
  event ConsentRecorderSet(address indexed recorder, bool allowed);

  error InvalidSignature();
  error SignatureUsed();
  error TimestampOutOfRange();
  error InvalidV();
  error HexLengthInsufficient();
  error ZeroAddressNotAllowed();
  error UnauthorizedCaller();
  error AlreadyInit();
  error InvalidTerms();
  error NoActiveTerms();

  string private constant MESSAGE_PREFIX = "By proceeding with creating a new contract, I agree to 10102's Terms of Service";
  uint256 private constant MAX_PAST_OFFSET = 30 minutes;
  uint256 private constant MAX_FUTURE_OFFSET = 30 minutes;

  constructor () {
    _disableInitializers();
  }

  function initialize(address initialOwner) public initializer {
    __Ownable_init(initialOwner);
  }

  modifier onlyRouter() {
    if (msg.sender != transferLegacy && msg.sender != transferLegacyEOA && msg.sender != multisigLegacy) revert UnauthorizedCaller();
    _;
  }

  function setRouterAddresses(address _transferLegacyEOA, address _transferLegacy, address _multisigLegacy) external onlyOwner {
    //if (transferLegacyEOA != address(0)) revert AlreadyInit();

    // _transferLegacy is allowed to be address(0) since the Safe-source
    // Transfer flow was sunset (v2026.05.18). The storage slot is
    // preserved for upgradeability — see comment in LegacyDeployer.sol.
    if (_transferLegacyEOA == address(0) || _multisigLegacy == address(0)) {
      revert ZeroAddressNotAllowed();
    }

    transferLegacyEOA = _transferLegacyEOA;
    transferLegacy = _transferLegacy;
    multisigLegacy = _multisigLegacy;
  }

  /// @notice Publish the terms version users must accept from now on.
  /// @param termsVersion_ Short human-readable tag embedded in the signed
  ///   message (e.g. "v2026-07"). Empty string (with zero hash) disables
  ///   versioning and falls back to the legacy message format.
  /// @param termsHash_ keccak256 of the full ToS document text in force —
  ///   the on-chain link from the tag to the exact terms.
  function setActiveTerms(string calldata termsVersion_, bytes32 termsHash_) external onlyOwner {
    // Both set or both empty — a tag without a document hash (or vice
    // versa) would break the tag -> document bind this feature exists for.
    if ((bytes(termsVersion_).length == 0) != (termsHash_ == bytes32(0))) revert InvalidTerms();
    activeTermsVersion = termsVersion_;
    activeTermsHash = termsHash_;
    if (termsHash_ != bytes32(0)) {
      termsVersionOf[termsHash_] = termsVersion_;
    }
    emit ActiveTermsUpdated(termsVersion_, termsHash_);
  }

  /// @notice Authorize (or revoke) a contract to record tx-based consent.
  function setConsentRecorder(address recorder_, bool allowed_) external onlyOwner {
    if (recorder_ == address(0)) revert ZeroAddressNotAllowed();
    consentRecorders[recorder_] = allowed_;
    emit ConsentRecorderSet(recorder_, allowed_);
  }

  /**
   * @notice Record tx-based consent for `user_`, binding it to the active
   * terms. Only callable by authorized recorder contracts (the routers),
   * which pass their tx signer as `user_` — the transaction signature is the
   * cryptographic attribution, so no separate message signature is needed.
   * Requires published active terms: consent must always bind to an exact
   * terms document, otherwise the record would attest to nothing.
   */
  function recordConsent(address user_, uint256 refId_) external {
    if (!consentRecorders[msg.sender]) revert UnauthorizedCaller();
    if (activeTermsHash == bytes32(0)) revert NoActiveTerms();
    userConsents[user_].push(
      Consent({termsHash: activeTermsHash, timestamp: uint64(block.timestamp), recorder: msg.sender, refId: refId_})
    );
    emit ConsentRecorded(user_, activeTermsHash, msg.sender, refId_, activeTermsVersion, block.timestamp);
  }

  function getUserConsentCount(address user) external view returns (uint256) {
    return userConsents[user].length;
  }

  /// @notice Full tx-based consent record incl. the version tag the bound
  /// terms hash was published under.
  function getUserConsent(
    address user,
    uint256 index
  ) external view returns (bytes32 termsHash, string memory termsVersion, uint256 timestamp, address recorder, uint256 refId) {
    Consent memory c = userConsents[user][index];
    return (c.termsHash, termsVersionOf[c.termsHash], c.timestamp, c.recorder, c.refId);
  }

  /// @notice Store a legacy agreement signed via signMessage.
  /// @dev Dual-accept: when active terms are published, first verify against
  /// the versioned message (binding the consent to `activeTermsHash`); fall
  /// back to the legacy un-versioned message so pre-upgrade frontends and
  /// already-stashed signatures keep working (those record a zero hash).
  function storeLegacyAgreement(address user, address legacyAddress, uint256 timestamp, bytes calldata signature) external nonReentrant onlyRouter {
    uint256 nowTs = block.timestamp;
    if (timestamp < nowTs - MAX_PAST_OFFSET || timestamp > nowTs + MAX_FUTURE_OFFSET) {
      revert TimestampOutOfRange();
    }
    if (signatureUsed[signature] != 0) revert SignatureUsed();

    bool versioned = false;
    if (activeTermsHash != bytes32(0)) {
      bytes32 versionedHash = _getEthSignedMessageHash(generateVersionedMessage(timestamp));
      versioned = recoverSigner(versionedHash, signature) == user;
    }
    if (!versioned) {
      bytes32 legacyHash = _getEthSignedMessageHash(generateMessage(timestamp));
      if (recoverSigner(legacyHash, signature) != user) {
        revert InvalidSignature();
      }
    }

    legacySigned[user].push(Legacy({legacyAddress: legacyAddress, timestamp: timestamp, signature: signature}));
    signatureUsed[signature] = timestamp;

    emit LegacySigned(user, uint256(uint160(legacyAddress)), timestamp);
    if (versioned) {
      signatureTermsHash[signature] = activeTermsHash;
      emit LegacySignedVersioned(user, uint256(uint160(legacyAddress)), timestamp, activeTermsVersion, activeTermsHash);
    }
  }

  function _getEthSignedMessageHash(string memory message) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n", _uintToString(bytes(message).length), message));
  }

  function getUserLegacyCount(address user) external view returns (uint256) {
    return legacySigned[user].length;
  }

  function getUserLegacy(
    address user,
    uint256 index
  ) external view returns (address legacyAddress, uint256 timestamp, string memory message, bytes memory signature) {
    Legacy memory legacy = legacySigned[user][index];
    // Reconstruct the exact message this record was signed over: versioned
    // records use the historical tag looked up via their document hash.
    // (Pre-existing bug fixed in passing: this used to call
    // generateMessage(timestamp) on the still-unassigned named return —
    // i.e. always timestamp 0 — instead of the record's own timestamp.)
    bytes32 tHash = signatureTermsHash[legacy.signature];
    string memory termString = tHash == bytes32(0)
      ? generateMessage(legacy.timestamp)
      : _versionedMessage(termsVersionOf[tHash], legacy.timestamp);
    return (legacy.legacyAddress, legacy.timestamp, termString, legacy.signature);
  }

  function recoverSigner(bytes32 digest, bytes memory signature) public pure returns (address) {
    if (signature.length != 65) {
      revert InvalidSignature();
    }

    bytes32 r;
    bytes32 s;
    uint8 v;

    assembly {
      r := mload(add(signature, 0x20))
      s := mload(add(signature, 0x40))
      v := byte(0, mload(add(signature, 0x60)))
    }

    // Validate s is in lower half of secp256k1 curve order (EIP-2)
    if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
      revert InvalidSignature();
    }

    if (v < 27) v += 27;
    if (v != 27 && v != 28) {
      revert InvalidV();
    }

    return ecrecover(digest, v, r, s);
  }

   function generateMessage(uint256 timestamp) public pure returns (string memory) {
    return string.concat(MESSAGE_PREFIX, " at timestamp ", _uintToString(timestamp), ".");
  }

  /// @notice The message users must sign while terms versioning is active.
  /// Frontends call this (or mirror its format) so wallet prompt and
  /// on-chain verification agree byte-for-byte. Falls back to the legacy
  /// format when no active terms are published.
  function generateVersionedMessage(uint256 timestamp) public view returns (string memory) {
    if (activeTermsHash == bytes32(0)) return generateMessage(timestamp);
    return _versionedMessage(activeTermsVersion, timestamp);
  }

  function _versionedMessage(string memory termsVersion_, uint256 timestamp) internal pure returns (string memory) {
    return string.concat(
      MESSAGE_PREFIX,
      " (version ",
      termsVersion_,
      ") at timestamp ",
      _uintToString(timestamp),
      "."
    );
  }

  /// @notice Terms-document hash bound to a stored consent record; zero for
  /// records created before versioning was active.
  function getUserLegacyTermsHash(address user, uint256 index) external view returns (bytes32) {
    return signatureTermsHash[legacySigned[user][index].signature];
  }



  function _uintToString(uint256 value) internal pure returns (string memory) {
    if (value == 0) return "0";
    uint256 temp = value;
    uint256 digits;
    while (temp != 0) {
      digits++;
      temp /= 10;
    }
    bytes memory buffer = new bytes(digits);
    while (value != 0) {
      digits -= 1;
      buffer[digits] = bytes1(uint8(48 + (value % 10)));
      value /= 10;
    }
    return string(buffer);
  }

  function _toHexString(address account) internal pure returns (string memory) {
    return _toHexString(uint256(uint160(account)), 20);
  }

  function _toHexString(uint256 value, uint256 length) internal pure returns (string memory) {
    bytes16 _hexSymbols = "0123456789abcdef";
    bytes memory buffer = new bytes(2 + length * 2);
    buffer[0] = "0";
    buffer[1] = "x";
    for (uint256 i = 2 + length * 2; i > 2; --i) {
      buffer[i - 1] = _hexSymbols[value & 0xf];
      value >>= 4;
    }
    if (value != 0) revert HexLengthInsufficient();
    return string(buffer);
  }
}
