// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {GenericLegacy} from "../common/GenericLegacy.sol";
import {ISafeGuard} from "../interfaces/ISafeGuard.sol";
import {ISafeWallet} from "../interfaces/ISafeWallet.sol";
import {MultisigLegacyStruct} from "../libraries/MultisigLegacyStruct.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/libraries/Enum.sol";

contract MultisigLegacy is GenericLegacy {
  error BeneficiaryInvalid();
  error NotBeneficiary();
  error NotEnoughContitionalActive();
  error ExecTransactionFromModuleFailed();
  error LengthMismatch();

  using EnumerableSet for EnumerableSet.AddressSet;

  /* State variable */
  uint128 public constant LEGACY_TYPE = 1;
  uint128 public _minRequiredSignatures = 1;
  EnumerableSet.AddressSet private _beneficiariesSet;
  address public safeGuard;
  address public creator;

  /* View functions to support premium */

  ///@dev false if legacy has been deleted or activated
  function isLive() public view override returns (bool) {
    return getIsActiveLegacy() == 1;
  }

  ///@dev get the timestamp when activation can be triggered
  function getTriggerActivationTimestamp() public view override returns (uint256, uint256, uint256) {
    //last tx of safe wallet linked with this legacy
    // find guard address for this contract

    uint256 lastTimestamp = ISafeGuard(safeGuard).getLastTimestampTxs();
    uint256 lackOfOutgoingTxRange = getActivationTrigger();
    uint256 beneficiariesTrigger = lastTimestamp + lackOfOutgoingTxRange;

    return (beneficiariesTrigger, beneficiariesTrigger, beneficiariesTrigger);
  }

  function getLegacyBeneficiaries() public view override returns (address[] memory, address, address) {
    return (_beneficiariesSet.values(), address(0), address(0));
  }

  function getLastTimestamp() public view override returns (uint256) {
    return ISafeGuard(safeGuard).getLastTimestampTxs();
  }

  /* View function */
  /**
   * @dev get beneficiaries list
   */
  function getBeneficiaries() external view returns (address[] memory) {
    return _beneficiariesSet.values();
  }

  /**
   * @dev get minRequiredSignatures
   */
  function getMinRequiredSignatures() external view returns (uint128) {
    return _minRequiredSignatures;
  }

  /**
   * @dev Check activation conditions
   * @param guardAddress_ guard
   * @return bool true if eligible for activation, false otherwise
   */
  function checkActiveLegacy(address guardAddress_) external view returns (bool) {
    return _checkActiveLegacy(guardAddress_);
  }

  /* Main function */
  /**
   * @dev Initialize info legacy
   * @param legacyId_ legacy id
   * @param owner_ owner of legacy
   * @param beneficiaries_ beneficiaries list
   * @param config_ include minRequiredSignatures, lackOfOutgoingTxRange
   */
  function initialize(
    uint256 legacyId_,
    address owner_,
    address[] calldata beneficiaries_,
    MultisigLegacyStruct.LegacyExtraConfig calldata config_,
    address _safeGuard,
    address _creator,
    string[] calldata nicknames_
  ) external notInitialized returns (uint256 numberOfBeneficiaries) {
    if (owner_ == address(0)) revert OwnerInvalid();
    if (_safeGuard == address(0)) revert OwnerInvalid();
    if (_creator == address(0)) revert OwnerInvalid();

    //set info legacy
    _setLegacyInfo(legacyId_, owner_, 1, config_.lackOfOutgoingTxRange, msg.sender);

    //set minRequiredSignatures
    _setMinRequiredSignatures(config_.minRequiredSignatures);

    //set beneficiaries
    numberOfBeneficiaries = _setBeneficiaries(owner_, beneficiaries_, nicknames_);

    safeGuard = _safeGuard;
    creator = _creator;
  }

  /**
   * @dev Set beneficiaries[], minRequiredSignatures legacy
   * @param sender_  sender address
   * @param beneficiaries_ beneficiaries list
   * @param minRequiredSigs_ minRequiredSignatures
   * @return numberOfBeneficiaries numberOfBeneficiares
   */
  function setLegacyBeneficiaries(
    address sender_,
    address[] calldata beneficiaries_,
    uint128 minRequiredSigs_,
    string[] calldata nicknames_
  ) external onlyRouter onlyOwner(sender_) isActiveLegacy returns (uint256 numberOfBeneficiaries) {
    if (beneficiaries_.length != nicknames_.length) revert LengthMismatch();
    //clear beneficiaries
    _clearBeneficiaries();

    //set minRequiredSignatures
    _setMinRequiredSignatures(minRequiredSigs_);

    //set beneficiaries
    numberOfBeneficiaries = _setBeneficiaries(sender_, beneficiaries_, nicknames_);
  }

  /**
   * @dev Set lackOfOutgoingTxRange legacy
   * @param sender_  sender address
   * @param lackOfOutgoingTxRange_  lackOfOutgoingTxRange
   */
  function setActivationTrigger(address sender_, uint128 lackOfOutgoingTxRange_) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    _setActivationTrigger(lackOfOutgoingTxRange_);
  }

  /**
   * @dev Active legacy
   * @param guardAddress_ guard address
   * @return newSigners new threshold list
   */
  function activeLegacy(address guardAddress_) external onlyRouter isActiveLegacy returns (address[] memory newSigners, uint256 newThreshold) {
    //Active legacy
    if (_checkActiveLegacy(guardAddress_)) {
      address[] memory beneficiariesList = _beneficiariesSet.values();
      _setLegacyToInactive();
      _clearBeneficiaries();
      (newSigners, newThreshold) = _addOwnerWithThreshold(beneficiariesList);
    } else {
      revert NotEnoughContitionalActive();
    }
  }

  function setLegacyName(string calldata legacyName_) external onlyRouter isActiveLegacy {
    _setLegacyName(legacyName_);
  }

  /* Utils function */
  /**
   * @dev Check activation conditions
   * @param guardAddress_ guard
   * @return bool true if eligible for activation, false otherwise
   */
  function _checkActiveLegacy(address guardAddress_) private view returns (bool) {
    uint256 lastTimestamp = ISafeGuard(guardAddress_).getLastTimestampTxs();
    uint256 lackOfOutgoingTxRange = getActivationTrigger();
    if (lastTimestamp + lackOfOutgoingTxRange > block.timestamp) {
      return false;
    }
    return true;
  }

  /**
   * @dev Set beneficiaries[], minRequiredSignatures legacy
   * @param owner_  owner legacy
   * @param beneficiaries_  beneficiaries[]
   */
  function _setBeneficiaries(
    address owner_,
    address[] calldata beneficiaries_,
    string[] calldata nicknames_
  ) private returns (uint256 numberOfBeneficiaries) {
    address[] memory signers = ISafeWallet(owner_).getOwners();
    for (uint256 i = 0; i < beneficiaries_.length; ) {
      _checkBeneficiaries(signers, owner_, beneficiaries_[i]);
      _beneficiariesSet.add(beneficiaries_[i]);
      _setBeneNickname(beneficiaries_[i], nicknames_[i]);
      unchecked {
        ++i;
      }
    }
    numberOfBeneficiaries = _beneficiariesSet.length();
  }

  /**
   * @dev set minRequireSignatures
   * @param minRequiredSignatures_  minRequireSignatures
   */
  function _setMinRequiredSignatures(uint128 minRequiredSignatures_) private {
    _minRequiredSignatures = minRequiredSignatures_;
  }

  /**
   * @dev Clear benecifiaries list of legacy
   */
  function _clearBeneficiaries() private {
    uint256 length = _beneficiariesSet.length();
    for (uint256 i = 0; i < length; ) {
      _deleteBeneName(_beneficiariesSet.at(0));
      _beneficiariesSet.remove(_beneficiariesSet.at(0));
      unchecked {
        ++i;
      }
    }
  }

  /**
   * @dev Add beneficiaries and set threshold in safe wallet
   * @param newSigners, newThreshold
   */
  function _addOwnerWithThreshold(address[] memory beneficiaries_) private returns (address[] memory newSigners, uint256 newThreshold) {
    address owner = getLegacyOwner();
    uint256 threshold = ISafeWallet(owner).getThreshold();
    for (uint256 i = 0; i < beneficiaries_.length; ) {
      bytes memory addOwnerData = abi.encodeWithSignature("addOwnerWithThreshold(address,uint256)", beneficiaries_[i], threshold);
      unchecked {
        ++i;
      }
      bool successAddOwner = ISafeWallet(owner).execTransactionFromModule(owner, 0, addOwnerData, Enum.Operation.Call);
      if (!successAddOwner) revert ExecTransactionFromModuleFailed();
    }
    if (threshold != _minRequiredSignatures) {
      bytes memory changeThresholdData = abi.encodeWithSignature("changeThreshold(uint256)", _minRequiredSignatures);
      bool successChangeThreshold = ISafeWallet(owner).execTransactionFromModule(owner, 0, changeThresholdData, Enum.Operation.Call);
      if (!successChangeThreshold) revert ExecTransactionFromModuleFailed();
    }
    newSigners = ISafeWallet(owner).getOwners();
    newThreshold = ISafeWallet(owner).getThreshold();
  }

  /**
   *
   * @param signers_  signer list
   * @param owner_  safe wallet address
   * @param beneficiary_ beneficiary address
   */
  function _checkBeneficiaries(address[] memory signers_, address owner_, address beneficiary_) private pure {
    if (beneficiary_ == address(0) || beneficiary_ == owner_) revert BeneficiaryInvalid();

    for (uint256 j = 0; j < signers_.length; ) {
      if (beneficiary_ == signers_[j]) revert BeneficiaryInvalid();
      unchecked {
        j++;
      }
    }
  }
}
