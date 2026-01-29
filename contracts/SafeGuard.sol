// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

import {ISafeWallet} from "./interfaces/ISafeWallet.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/libraries/Enum.sol";
import {ISignatureValidator} from "@safe-global/safe-contracts/contracts/interfaces/ISignatureValidator.sol";
import {BaseGuard} from "@safe-global/safe-contracts/contracts/examples/guards/BaseGuard.sol";
import {SafeMath} from "@safe-global/safe-contracts/contracts/external/SafeMath.sol";

contract SafeGuard is BaseGuard {
  using SafeMath for uint256;

  /*Error */
  error SafeGuardInitialized();
  error ThresholdOfSafeWalletIsInvalid();

  /*State */
  uint256 public lastTimestampTxs;
  ISafeWallet public safeWallet;

  /*Modifier */
  modifier initialized() {
    if (lastTimestampTxs != 0) revert SafeGuardInitialized();
    _;
  }

  /* Function */
  /**
   * @dev initialize last timestamp transaction
   */
  function initialize(address _safeWallet) external initialized {
    lastTimestampTxs = block.timestamp;
    safeWallet = ISafeWallet(_safeWallet);
  }

  /**
   * @dev check transaction
   * @param to  target address
   * @param value value
   * @param data data
   * @param operation call or delegateCall
   * @param safeTxGas safeTxGas
   * @param baseGas baseGas
   * @param gasPrice gasPrice
   * @param gasToken gasToken
   * @param refundReceiver refundReceiver
   * @param signatures signatures
   * @param msgSender sender
   */
  function checkTransaction(
    address to,
    uint256 value,
    bytes memory data,
    Enum.Operation operation,
    uint256 safeTxGas,
    uint256 baseGas,
    uint256 gasPrice,
    address gasToken,
    address payable refundReceiver,
    bytes memory signatures,
    address msgSender
  ) external {
    if (msg.sender == address(safeWallet)) {
      lastTimestampTxs = block.timestamp;
    } else {
      if (msg.sender == msgSender) {
        uint256 nonce = safeWallet.nonce();
        nonce--;
        bytes32 dataHash = keccak256(
          safeWallet.encodeTransactionData(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce)
        );
        uint256 requiredSignatures = safeWallet.getThreshold();

        checkNSignatures(msgSender, dataHash, data, signatures, requiredSignatures);
        lastTimestampTxs = block.timestamp;
      }
    }
  }

  /**
   * @dev check after execution
   * @param hash safe transaction hash
   * @param success true is success false otherwise
   */
  function checkAfterExecution(bytes32 hash, bool success) external {}

  /**
   * @dev check module transaction
   * @param to target address
   * @param value value
   * @param data data
   * @param operation call or delegateCall
   * @param module module address
   * @return moduleTxHash hash of the module transaction
   */
  function checkModuleTransaction(
    address to,
    uint256 value,
    bytes memory data,
    Enum.Operation operation,
    address module
  ) external returns (bytes32 moduleTxHash) {
    lastTimestampTxs = block.timestamp;
    return keccak256(abi.encodePacked(to, value, data, operation, module));
  }

  /**
   * @dev check after module execution
   * @param txHash module transaction hash
   * @param success true is success false otherwise
   */
  function checkAfterModuleExecution(bytes32 txHash, bool success) external {}

  /**
   * @dev get last timestamp transaction
   */
  function getLastTimestampTxs() external view returns (uint256) {
    return lastTimestampTxs;
  }

  /**
   * @notice Checks whether the signature provided is valid for the provided data and hash. Reverts otherwise.
   * @dev Since the EIP-1271 does an external call, be mindful of reentrancy attacks.
   * @param dataHash Hash of the data (could be either a message hash or transaction hash)
   * @param data That should be signed (this is passed to an external validator contract)
   * @param signatures Signature data that should be verified.
   *                   Can be packed ECDSA signature ({bytes32 r}{bytes32 s}{uint8 v}), contract signature (EIP-1271) or approved hash.
   * @param requiredSignatures Amount of required valid signatures.
   */
  function checkNSignatures(address sender, bytes32 dataHash, bytes memory data, bytes memory signatures, uint256 requiredSignatures) public view {
    // Check that the provided signature data is not too short
    require(signatures.length >= requiredSignatures.mul(65), "GS020");
    // There cannot be an owner with address 0.
    address lastOwner = address(0);
    address currentOwner;
    uint8 v;
    bytes32 r;
    bytes32 s;
    uint256 i;
    for (i = 0; i < requiredSignatures; i++) {
      (v, r, s) = signatureSplit(signatures, i);
      if (v == 0) {
        require(keccak256(data) == dataHash, "GS027");
        // If v is 0 then it is a contract signature
        // When handling contract signatures the address of the contract is encoded into r
        currentOwner = address(uint160(uint256(r)));

        // Check that signature data pointer (s) is not pointing inside the static part of the signatures bytes
        // This check is not completely accurate, since it is possible that more signatures than the threshold are send.
        // Here we only check that the pointer is not pointing inside the part that is being processed
        require(uint256(s) >= requiredSignatures.mul(65), "GS021");

        // Check that signature data pointer (s) is in bounds (points to the length of data -> 32 bytes)
        require(uint256(s).add(32) <= signatures.length, "GS022");

        // Check if the contract signature is in bounds: start of data is s + 32 and end is start + signature length
        uint256 contractSignatureLen;
        // solhint-disable-next-line no-inline-assembly
        assembly {
          contractSignatureLen := mload(add(add(signatures, s), 0x20))
        }
        require(uint256(s).add(32).add(contractSignatureLen) <= signatures.length, "GS023");

        // Check signature
        bytes memory contractSignature;
        // solhint-disable-next-line no-inline-assembly
        assembly {
          // The signature data for contract signatures is appended to the concatenated signatures and the offset is stored in s
          contractSignature := add(add(signatures, s), 0x20)
        }
        require(
          ISignatureValidator(currentOwner).isValidSignature(keccak256(data), contractSignature) == bytes4(ISignatureValidator.isValidSignature.selector),
          "GS024"
        );
      } else if (v == 1) {
        // If v is 1 then it is an approved hash
        // When handling approved hashes the address of the approver is encoded into r
        currentOwner = address(uint160(uint256(r)));
        // Hashes are automatically approved by the sender of the message or when they have been pre-approved via a separate transaction
        require(sender == currentOwner || safeWallet.approvedHashes(currentOwner, dataHash) != 0, "GS025");
      } else if (v > 30) {
        // If v > 30 then default va (27,28) has been adjusted for eth_sign flow
        // To support eth_sign and similar we adjust v and hash the messageHash with the Ethereum message prefix before applying ecrecover
        currentOwner = _recover(keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash)), v - 4, r, s);
      } else {
        // Default is the ecrecover flow with the provided data hash
        // Use ecrecover with the messageHash for EOA signatures
        currentOwner = _recover(dataHash, v, r, s);
      }
      require(currentOwner > lastOwner, "GS026");
      lastOwner = currentOwner;
    }
  }

  /**
   * @notice Splits signature bytes into `uint8 v, bytes32 r, bytes32 s`.
   * @dev Make sure to perform a bounds check for @param pos, to avoid out of bounds access on @param signatures
   *      The signature format is a compact form of {bytes32 r}{bytes32 s}{uint8 v}
   *      Compact means uint8 is not padded to 32 bytes.
   * @param pos Which signature to read.
   *            A prior bounds check of this parameter should be performed, to avoid out of bounds access.
   * @param signatures Concatenated {r, s, v} signatures.
   * @return v Recovery ID or Safe signature type.
   * @return r Output value r of the signature.
   * @return s Output value s of the signature.
   */
  function signatureSplit(bytes memory signatures, uint256 pos) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
      let signaturePos := mul(0x41, pos)
      r := mload(add(signatures, add(signaturePos, 0x20)))
      s := mload(add(signatures, add(signaturePos, 0x40)))
      /**
       * Here we are loading the last 32 bytes, including 31 bytes
       * of 's'. There is no 'mload8' to do this.
       * 'byte' is not working due to the Solidity parser, so lets
       * use the second best option, 'and'
       */
      v := and(mload(add(signatures, add(signaturePos, 0x41))), 0xff)
    }
  }

  function _recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
    // enforce EIP-2 lower s
    require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Invalid s value");
    if (v < 27) v += 27;
    require(v == 27 || v == 28, "Invalid v");
    return ecrecover(hash, v, r, s);
  }
}
