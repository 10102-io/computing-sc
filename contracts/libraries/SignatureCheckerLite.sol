// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @dev Vendored, unmodified subset of OpenZeppelin Contracts v5.4.0
 * `utils/cryptography/SignatureChecker.sol` (MIT). Only the two functions we
 * need — EOA-or-ERC-1271 verification — are included; the ERC-7913 extensions
 * are omitted.
 *
 * WHY VENDORED: OZ v5.4's SignatureChecker pins `pragma ^0.8.24` while this
 * repo compiles at 0.8.20 (the solc bump is a deliberately isolated task —
 * see docs/plans/solc-upgrade.md). The logic below is byte-for-byte OZ's; in
 * particular the ERC-1271 branch requires the staticcall to SUCCEED **and**
 * return at least 32 bytes decoding to the exact magic value — the checks
 * whose absence caused the Zodiac ERC-1271 bypass (create-flow-v2.md §12a
 * "Smart-contract-wallet signers + the Zodiac ERC-1271 lesson").
 *
 * TODO(deferred): swap imports back to OZ SignatureChecker and delete this
 * file when the solc-upgrade task lands (>= 0.8.24).
 */
library SignatureCheckerLite {
  /**
   * @dev Checks if a signature is valid for a given signer and data hash. If the signer has code, the
   * signature is validated against it using ERC-1271, otherwise it's validated using `ECDSA.recover`.
   *
   * NOTE: Unlike ECDSA signatures, contract signatures are revocable, and the outcome of this function can thus
   * change through time. It could return true at block N and false at block N+1 (or the opposite).
   */
  function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
    if (signer.code.length == 0) {
      (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
      return err == ECDSA.RecoverError.NoError && recovered == signer;
    } else {
      return isValidERC1271SignatureNow(signer, hash, signature);
    }
  }

  /**
   * @dev Checks if a signature is valid for a given signer and data hash. The signature is validated
   * against the signer smart contract using ERC-1271.
   */
  function isValidERC1271SignatureNow(
    address signer,
    bytes32 hash,
    bytes memory signature
  ) internal view returns (bool) {
    (bool success, bytes memory result) = signer.staticcall(
      abi.encodeCall(IERC1271.isValidSignature, (hash, signature))
    );
    return (success &&
      result.length >= 32 &&
      abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector));
  }
}
