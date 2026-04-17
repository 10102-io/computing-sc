// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {MultisigLegacyStruct} from "../libraries/MultisigLegacyStruct.sol";

interface IMultisigLegacy {
  function initialize(
    uint256 legacyId_,
    address owner_,
    address[] calldata beneficiaries_,
    MultisigLegacyStruct.LegacyExtraConfig calldata config_,
    address _safeGuard,
    address creator,
    string[] calldata nicknames_
  ) external returns (uint256 numberOfBeneficiaries);

  function setLegacyBeneficiaries(
    address sender_,
    address[] calldata beneficiaries_,
    uint128 minRequiredSigs_,
    string[] calldata nicknames_
  ) external returns (uint256 numberOfBeneficiaries);

  function setActivationTrigger(address sender_, uint128 lackOfOutgoingTxRange_) external;

  function activeLegacy(address guardAddress_) external returns (address[] memory newSigners, uint256 newThreshold);

  function checkActiveLegacy(address guardAddress_) external view returns (bool);

  function setLegacyName(string calldata legacyName_) external;

}
