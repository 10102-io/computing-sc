// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @title QuantumRecoveryRegistry
 * @notice An append-only registry where any account (EOA or smart wallet)
 * commits, today, to a post-quantum recovery credential it may need tomorrow.
 *
 * Why this exists (the recovery paradox): once ECDSA is broken, an attacker
 * holding a cracked key is cryptographically indistinguishable from the
 * owner. No future recovery mechanism — an app-level vault, a Safe module,
 * or an Ethereum protocol fork — can tell them apart UNLESS a quantum-safe
 * second factor was bound to the account BEFORE the break. The commitment
 * stored here is just a hash (safe against Shor's algorithm; Grover only
 * dents keccak quadratically), so registering it reveals nothing. What the
 * chain provides is the part that cannot be back-dated: the timestamp.
 *
 * What this contract deliberately is NOT:
 * - It is not an enforcement mechanism. Nothing here can move funds or veto
 *   a transaction. Enforcement (delay vaults, Safe guards, protocol-level
 *   recovery per the post-quantum recovery registry ERC discussions) arrives
 *   separately and honors commitments recorded before a publicly agreed
 *   breach date.
 * - It is not upgradeable and has no owner. A "quantum-safe" registry whose
 *   admin key could rewrite history would undercut its own claim.
 *
 * Registration is msg.sender-only: an EOA (hardware wallet included) signs a
 * normal transaction; a Safe routes the same call through execTransaction so
 * the commitment is recorded for the Safe address itself. History is
 * append-only — later entries never erase earlier ones, because the earliest
 * pre-breach timestamp is exactly what a future verifier needs.
 *
 * `scheme` is an informational label for the committed credential:
 *   0 = unspecified          3 = FN-DSA / Falcon (FIPS 206, draft)
 *   1 = SLH-DSA (FIPS 205)   4 = WOTS+ / hash-based one-time key
 *   2 = ML-DSA (FIPS 204)    5 = plain hash preimage (secret)
 * Values above 5 are reserved for future schemes; the contract does not
 * gate on them.
 *
 * `recoveryContext` optionally names the contract this commitment is meant
 * to protect or route through — e.g. the account's 10102 legacy contract or
 * a Safe. Purely descriptive; zero address means "the account itself".
 */
contract QuantumRecoveryRegistry {
  struct Commitment {
    /// @dev keccak256 (or other 32-byte hash) of a PQ public key or secret.
    bytes32 digest;
    /// @dev block timestamp at registration — the actual asset here.
    uint64 registeredAt;
    /// @dev informational scheme label, see contract natspec.
    uint8 scheme;
    /// @dev optional contract this commitment protects (0 = the account).
    address recoveryContext;
  }

  mapping(address => Commitment[]) private _history;

  event CommitmentRegistered(
    address indexed account,
    uint256 indexed index,
    bytes32 digest,
    uint8 scheme,
    address recoveryContext
  );

  error EmptyDigest();

  /// @notice Append a commitment for msg.sender. Never overwrites history.
  function register(bytes32 digest, uint8 scheme, address recoveryContext) external returns (uint256 index) {
    if (digest == bytes32(0)) revert EmptyDigest();
    index = _history[msg.sender].length;
    _history[msg.sender].push(
      Commitment({
        digest: digest,
        registeredAt: uint64(block.timestamp),
        scheme: scheme,
        recoveryContext: recoveryContext
      })
    );
    emit CommitmentRegistered(msg.sender, index, digest, scheme, recoveryContext);
  }

  /// @notice Number of commitments an account has registered.
  function commitmentCount(address account) external view returns (uint256) {
    return _history[account].length;
  }

  /// @notice A single commitment by index (0 = earliest).
  function commitmentAt(address account, uint256 index) external view returns (Commitment memory) {
    return _history[account][index];
  }

  /// @notice The earliest commitment — the one a future verifier cares about.
  /// @dev Reverts if the account never registered; check commitmentCount first.
  function firstCommitment(address account) external view returns (Commitment memory) {
    return _history[account][0];
  }

  /// @notice The most recent commitment.
  /// @dev Reverts if the account never registered; check commitmentCount first.
  function latestCommitment(address account) external view returns (Commitment memory) {
    Commitment[] storage list = _history[account];
    return list[list.length - 1];
  }

  /// @notice Full history for an account.
  function commitmentsOf(address account) external view returns (Commitment[] memory) {
    return _history[account];
  }
}
