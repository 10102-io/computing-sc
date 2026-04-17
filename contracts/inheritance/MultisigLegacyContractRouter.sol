// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

import {LegacyRouter} from "../common/LegacyRouter.sol";
import {LegacyFactory} from "../common/LegacyFactory.sol";
import {MultisigLegacy} from "./MultisigLegacyContract.sol";
import {SafeGuard} from "../SafeGuard.sol";
import {IMultisigLegacy} from "../interfaces/IMultisigLegacyContract.sol";
import {ISafeGuard} from "../interfaces/ISafeGuard.sol";
import {ISafeWallet} from "../interfaces/ISafeWallet.sol";
import {MultisigLegacyStruct} from "../libraries/MultisigLegacyStruct.sol";
import {EIP712LegacyVerifier} from "../term/VerifierTerm.sol";
import {IPremiumSetting} from "../interfaces/IPremiumSetting.sol";
contract MultisigLegacyRouter is LegacyRouter, LegacyFactory, ReentrancyGuardUpgradeable {
  EIP712LegacyVerifier public verifier;
  address public premiumSetting;

  
  /* Error */
  error ExistedGuardInSafeWallet(address);
  error SignerIsNotOwnerOfSafeWallet();
  error NumBeneficiariesInvalid();
  error BeneficiariesInvalid();
  error MinRequiredSignaturesInvalid();
  error ActivationTriggerInvalid();

  /* Struct */
  struct LegacyMainConfig {
    string name;
    string note;
    string[] nickNames;
    address[] beneficiaries;
  }

  /* Event */
  event MultisigLegacyCreated(
    uint256 legacyId,
    address legacyAddress,
    address guardAddress,
    address creatorAddress,
    address safeAddress,
    LegacyMainConfig mainConfig,
    MultisigLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );

  event MultisigLegacyConfigUpdated(
    uint256 legacyId,
    LegacyMainConfig mainConfig,
    MultisigLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );
  event MultisigLegacyBeneficiariesUpdated(
    uint256 legacyId,
    string[] nickName,
    address[] beneficiaries,
    uint128 minRequiredSignatures,
    uint256 timestamp
  );
  event MultisigLegacyActivationTriggerUpdated(uint256 legacyId, uint256 lackOfOutgoingTxRange, uint256 timestamp);
  event MultisigLegacyNameNoteUpdated(uint256 legacyId, string name, string note, uint256 timestamp);
  event MultisigLegacyActivated(uint256 legacyId, address[] newSigners, uint256 newThreshold, bool success, uint256 timestamp);
  event EmailActivatedNotCompleted(address legacyAddress);

  /* Modifier */
  modifier onlySafeWallet(uint256 legacyId_) {
    _checkSafeWalletValid(legacyId_, msg.sender);
    _;
  }

  constructor () {
    _disableInitializers();
  }

  function initialize(address _deployerContract, address _premiumSetting, address _verifier) public initializer {
    __ReentrancyGuard_init();
    legacyDeployerContract = _deployerContract;
    premiumSetting = _premiumSetting;
    verifier = EIP712LegacyVerifier(_verifier);
  }

  /**
   * @dev Get next legacy address that would be created for a sender
   * @param sender_ The address of the sender
   * @return address The next legacy address that would be created
   */
  function getNextLegacyAddress(address sender_) external view returns (address) {
    return _getNextAddress(type(MultisigLegacy).creationCode, sender_);
  }

  /* External function */
  /**
   * @dev Check activation conditions. This activation conditions is current time >= last transaction of safe wallet + lackOfOutgoingTxRange.
   * @param legacyId_ legacy id
   * @return bool true if eligible for activation, false otherwise
   */
  function checkActiveLegacy(uint256 legacyId_) external view returns (bool) {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    address guardAddress = _checkGuardExisted(legacyId_);

    return IMultisigLegacy(legacyAddress).checkActiveLegacy(guardAddress);
  }

  /* External function */
  /**
   * @dev Create new legacy and guard.
   * @param safeWallet safeWallet address
   * @param mainConfig_  include name, note, nickname[], beneficiaries[]
   * @param extraConfig_ include minRequireSignature, lackOfOutgoingTxRange
   * @return address legacy address
   * @return address guard address
   */
  function createLegacy(
    address safeWallet,
    LegacyMainConfig calldata mainConfig_,
    MultisigLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    uint256 signatureTimestamp,
    bytes calldata agreementSignature
  ) external nonReentrant returns (address, address) {
    //Check beneficiaries length
    if (mainConfig_.beneficiaries.length != mainConfig_.nickNames.length || mainConfig_.beneficiaries.length == 0) revert BeneficiariesInvalid();

    // Check invalid guard
    if (_checkExistGuardInSafeWallet(safeWallet)) {
      revert ExistedGuardInSafeWallet(safeWallet);
    }

    //Check invalid safe wallet
    if (!_checkSignerIsOwnerOfSafeWallet(safeWallet, msg.sender)) revert SignerIsNotOwnerOfSafeWallet();

    //Check activation trigger
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();

    // Create new legacy and guard
    (uint256 newLegacyId, address legacyAddress, address guardAddress) = _createLegacy(
      type(MultisigLegacy).creationCode,
      msg.sender
    );

    //Verify + store user agreement signature
    verifier.storeLegacyAgreement(msg.sender, legacyAddress, signatureTimestamp, agreementSignature);

    // Initialize legacy
    uint256 numberOfBeneficiaries = IMultisigLegacy(legacyAddress).initialize(
      newLegacyId,
      safeWallet,
      mainConfig_.beneficiaries,
      extraConfig_,
      guardAddress,
      msg.sender,
      mainConfig_.nickNames
    );

    IMultisigLegacy(legacyAddress).setLegacyName(mainConfig_.name);

    //Initialize safeguard
    ISafeGuard(guardAddress).initialize(safeWallet);

    //Check min require signatures
    if (extraConfig_.minRequiredSignatures == 0 || extraConfig_.minRequiredSignatures > numberOfBeneficiaries) revert MinRequiredSignaturesInvalid();

    // Check beneficiary limit
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();


    emit MultisigLegacyCreated(newLegacyId, legacyAddress, guardAddress, msg.sender, safeWallet, mainConfig_, extraConfig_, block.timestamp);

      //set private code for legacy of premium user
    IPremiumSetting(premiumSetting).setPrivateCodeAndCronjob(msg.sender,legacyAddress);

    return (legacyAddress, guardAddress);
  }

  /**
   * @dev Set legacy config include beneficiaries, minRequireSignatures, lackOfOutgoingTxRange.
   * @param legacyId_ legacy Id
   * @param mainConfig_ include name, note, nickname[], beneficiaries[]
   * @param extraConfig_ include minRequireSignature, lackOfOutgoingTxRange
   */
  function setLegacyConfig(
    uint256 legacyId_,
    LegacyMainConfig calldata mainConfig_,
    MultisigLegacyStruct.LegacyExtraConfig calldata extraConfig_
  ) external onlySafeWallet(legacyId_) nonReentrant {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    //Check beneficiaries length
    if (mainConfig_.beneficiaries.length != mainConfig_.nickNames.length || mainConfig_.beneficiaries.length == 0) revert BeneficiariesInvalid();

    //Check activation trigger
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();

    //Set beneficiaries
    uint256 numberOfBeneficiaries = IMultisigLegacy(legacyAddress).setLegacyBeneficiaries(
      msg.sender,
      mainConfig_.beneficiaries,
      extraConfig_.minRequiredSignatures,
      mainConfig_.nickNames
    );

    //Check min require signatures
    if (extraConfig_.minRequiredSignatures == 0 || extraConfig_.minRequiredSignatures > numberOfBeneficiaries) revert MinRequiredSignaturesInvalid();

    //Check beneficiary limit
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    //Set lackOfOutgoingTxRange
    IMultisigLegacy(legacyAddress).setActivationTrigger(msg.sender, extraConfig_.lackOfOutgoingTxRange);

    IMultisigLegacy(legacyAddress).setLegacyName(mainConfig_.name);
    
    emit MultisigLegacyConfigUpdated(legacyId_, mainConfig_, extraConfig_, block.timestamp);
  }

  /**
   * @dev Set beneficiaries[], minRequiredSignatures_ legacy, call this function if only modify beneficiaries[], minRequiredSignatures to save gas for user.
   * @param legacyId_ legacy id
   * @param nickName_ nick name[]
   * @param beneficiaries_ beneficiaries []
   * @param minRequiredSignatures_ minRequiredSignatures
   */

  function setLegacyBeneficiaries(
    uint256 legacyId_,
    string[] calldata nickName_,
    address[] calldata beneficiaries_,
    uint128 minRequiredSignatures_
  ) external onlySafeWallet(legacyId_) nonReentrant {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    //Check  beneficiaries length
    if (beneficiaries_.length != nickName_.length || beneficiaries_.length == 0) revert BeneficiariesInvalid();

    //Set beneficiaries[]
    uint256 numberOfBeneficiaries = IMultisigLegacy(legacyAddress).setLegacyBeneficiaries(msg.sender, beneficiaries_, minRequiredSignatures_, nickName_);

    //Check min require signatures
    if (minRequiredSignatures_ == 0 || minRequiredSignatures_ > numberOfBeneficiaries) revert MinRequiredSignaturesInvalid();

    //Check beneficiary limit
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    emit MultisigLegacyBeneficiariesUpdated(legacyId_, nickName_, beneficiaries_, minRequiredSignatures_, block.timestamp);
  }

  /**
   * @dev Set lackOfOutgoingTxRange legacy, call this function if only mofify lackOfOutgoingTxRange to save gas for user.
   * @param legacyId_ legacy id
   * @param lackOfOutgoingTxRange_ lackOfOutgoingTxRange
   */
  function setActivationTrigger(uint256 legacyId_, uint256 lackOfOutgoingTxRange_) external onlySafeWallet(legacyId_) nonReentrant {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    //Check activation trigger
    if (lackOfOutgoingTxRange_ == 0) revert ActivationTriggerInvalid();
    if (lackOfOutgoingTxRange_ > type(uint128).max) revert ActivationTriggerInvalid();

    //Set lackOfOutgoingTxRange
    IMultisigLegacy(legacyAddress).setActivationTrigger(msg.sender, uint128(lackOfOutgoingTxRange_));

    emit MultisigLegacyActivationTriggerUpdated(legacyId_, lackOfOutgoingTxRange_, block.timestamp);
  }

  /**
   * @dev Set name and note legacy, call this function if only modify name and note to save gas for user.
   * @param legacyId_ legacy id
   * @param name_ name legacy
   * @param note_ note legacy
   */
  function setNameNote(uint256 legacyId_, string calldata name_, string calldata note_) external onlySafeWallet(legacyId_) {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    IMultisigLegacy(legacyAddress).setLegacyName(name_);
    emit MultisigLegacyNameNoteUpdated(legacyId_, name_, note_, block.timestamp);
  }

  /**
   * @dev Active legacy, call this function when the safewallet is eligible for activation.
   * @param legacyId_ legacy id
   */
  function activeLegacy(uint256 legacyId_) external nonReentrant {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    address guardAddress = _checkGuardExisted(legacyId_);

    //trigger reminder
    try 
    IPremiumSetting(premiumSetting).triggerActivationMultisig(legacyAddress) 
    {} catch {
      emit EmailActivatedNotCompleted(legacyAddress);
    }

    //Active legacy
    (address[] memory newSigners, uint256 newThreshold) = IMultisigLegacy(legacyAddress).activeLegacy(guardAddress);

    emit MultisigLegacyActivated(legacyId_, newSigners, newThreshold, true, block.timestamp);
    
  }

}
