// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * Test doubles for the sponsored-path ERC-1271 support. The negative-path
 * mocks implement the exact adversarial shapes from the Zodiac post-mortem
 * (create-flow-v2.md §12a): a verifier that reverts with data *beginning with
 * the magic value*, one that returns the wrong value, and one that returns
 * short data — all of which a naive magic-value check would mistake for
 * acceptance.
 */

/// @dev Minimal Safe-style wallet: a single owner key; `isValidSignature`
/// accepts iff the hash was ECDSA-signed by that owner. Payable so it can
/// receive its ETH allocation on claim.
contract MockERC1271Wallet is IERC1271 {
  address public immutable owner;

  constructor(address owner_) {
    owner = owner_;
  }

  function isValidSignature(bytes32 hash_, bytes calldata signature_) external view returns (bytes4) {
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash_, signature_);
    if (err == ECDSA.RecoverError.NoError && recovered == owner) {
      return IERC1271.isValidSignature.selector;
    }
    return 0xffffffff;
  }

  receive() external payable {}
}

/// @dev Zodiac shape: REVERTS, with revert data whose first 4 bytes are the
/// ERC-1271 magic value. A checker that inspects returndata without requiring
/// call success treats this as a valid signature.
contract MockERC1271MagicRevert {
  function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
    bytes4 magic = IERC1271.isValidSignature.selector;
    assembly {
      mstore(0x00, magic)
      revert(0x00, 0x20)
    }
  }

  receive() external payable {}
}

/// @dev Returns successfully but with the wrong magic value.
contract MockERC1271WrongValue {
  function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
    return 0xdeadbeef;
  }

  receive() external payable {}
}

/// @dev Succeeds but returns only 4 raw bytes (the magic value, unpadded) —
/// a checker that abi.decodes without a returndata-length guard would revert
/// or misread. Raw `return` via assembly; a Solidity-level `returns (bytes)`
/// would ABI-encode to >32 bytes and defeat the point.
contract MockERC1271ShortReturn {
  fallback() external payable {
    assembly {
      mstore(0x00, 0x1626ba7e00000000000000000000000000000000000000000000000000000000)
      return(0x00, 0x04)
    }
  }

  receive() external payable {}
}
