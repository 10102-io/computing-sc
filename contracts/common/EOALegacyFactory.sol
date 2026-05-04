// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/Create2.sol";
import {ILegacyDeployer} from "../interfaces/ILegacyDeployer.sol";


contract EOALegacyFactory {
  /* Error */
  error LegacyNotFound();

  /* State variable */
  uint256 public _legacyId;
  address public legacyDeployerContract;
  mapping(uint256 => address) public legacyAddresses;
  mapping(address => bool) public isCreateLegacy;

  /* Internal function */
  /**
   * @dev get next address create
   * @param bytecode_  byte code
   * @param sender_  sender
   */
  function _getNextAddress(bytes memory bytecode_, address sender_) internal view returns (address) {
       return  ILegacyDeployer(legacyDeployerContract).getNextAddress(bytecode_ ,sender_);
  }

  /**
   * @dev create legacy
   * @param legacyBytecode_  legacy byte code

   * @param sender_ sender
   * @return legacyId
   * @return legacyAddress

   */
  function _createLegacy(bytes memory legacyBytecode_, address sender_) internal returns (uint256, address) {
    _legacyId += 1;
    (address legacyAddress,) = ILegacyDeployer(legacyDeployerContract).createLegacy(legacyBytecode_,sender_);
    legacyAddresses[_legacyId] = legacyAddress;
    isCreateLegacy[sender_] = true;

    return (_legacyId, legacyAddress);
  }

  /**
   * @dev EIP-1167 clone counterpart of `_createLegacy`. Caller is responsible for
   * invoking the implementation's initializer on the returned address.
   */
  function _cloneLegacy(address implementation_, address sender_) internal returns (uint256, address) {
    _legacyId += 1;
    address legacyAddress = ILegacyDeployer(legacyDeployerContract).cloneLegacy(implementation_, sender_);
    legacyAddresses[_legacyId] = legacyAddress;
    isCreateLegacy[sender_] = true;

    return (_legacyId, legacyAddress);
  }

  function _getNextCloneAddress(address implementation_, address sender_) internal view returns (address) {
    return ILegacyDeployer(legacyDeployerContract).getNextCloneAddress(implementation_, sender_);
  }

  /**
   * @dev Check whether legacy existed
   * @param legacyId_  legacy id
   */
  function _checkLegacyExisted(uint256 legacyId_) internal view returns (address legacyAddress) {
    legacyAddress = legacyAddresses[legacyId_];
    if (legacyAddress == address(0)) revert LegacyNotFound();
  }

  function _isCreateLegacy(address sender_) internal view returns (bool) {
    return isCreateLegacy[sender_];
  }
}
