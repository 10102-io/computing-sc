// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title NftCollectionWhiteList
 * @notice The ERC-721 and ERC-1155 collections an EOA legacy v3 may bequeath
 * (docs/plans/train-2026-11.md, wave B). Same administration as
 * TokenWhiteList: the deployer key at deployment, the governance Safe added
 * as co-admin (`scripts/add-safe-admin.ts`), either can revoke the other.
 *
 * The list is checked when an owner names NFT items, never at claim time: a
 * collection removed later stays claimable in legacies that already name it,
 * so no admin can stop an heir from receiving what was set aside.
 */
contract NftCollectionWhiteList is AccessControl {
  uint8 public constant KIND_ERC721 = 1;
  uint8 public constant KIND_ERC1155 = 2;
  bytes4 private constant IERC721_ID = 0x80ac58cd;
  bytes4 private constant IERC1155_ID = 0xd9b67a26;

  /// @notice 0 = not allowed, otherwise KIND_ERC721 or KIND_ERC1155.
  mapping(address collection => uint8) public kindOf;
  /// @notice Every collection ever added (some may since be removed).
  address[] public collectionList;
  mapping(address collection => bool) private _inList;

  error InvalidAdminAddress();
  error NotAnNftCollection(address collection);
  error AlreadyAllowed(address collection);

  event CollectionAdded(address indexed collection, uint8 kind);
  event CollectionRemoved(address indexed collection);

  constructor(address initialAdmin) {
    if (initialAdmin == address(0)) revert InvalidAdminAddress();
    _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
  }

  function addCollection(address collection) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (kindOf[collection] != 0) revert AlreadyAllowed(collection);
    uint8 kind = _probe(collection);
    if (kind == 0) revert NotAnNftCollection(collection);
    kindOf[collection] = kind;
    if (!_inList[collection]) {
      _inList[collection] = true;
      collectionList.push(collection);
    }
    emit CollectionAdded(collection, kind);
  }

  function removeCollection(address collection) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (kindOf[collection] == 0) return;
    kindOf[collection] = 0;
    emit CollectionRemoved(collection);
  }

  /// @notice The currently allowed collections.
  function getCollections() external view returns (address[] memory allowed) {
    allowed = new address[](collectionList.length);
    uint256 count;
    for (uint256 i; i < collectionList.length; ++i) {
      if (kindOf[collectionList[i]] != 0) allowed[count++] = collectionList[i];
    }
    assembly ("memory-safe") {
      mstore(allowed, count)
    }
  }

  function _probe(address collection) private view returns (uint8) {
    if (collection.code.length == 0) return 0;
    try IERC165(collection).supportsInterface(IERC721_ID) returns (bool is721) {
      if (is721) return KIND_ERC721;
    } catch {
      return 0;
    }
    try IERC165(collection).supportsInterface(IERC1155_ID) returns (bool is1155) {
      if (is1155) return KIND_ERC1155;
    } catch {}
    return 0;
  }
}
