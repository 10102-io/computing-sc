// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;
///@dev for premium to view Legacy
interface IPremiumLegacy {
  
  //Generic
  function getLegacyOwner() external view returns (address);
  function getLegacyInfo() external view returns (uint256, address, uint128);
  function getActivationTrigger () external view returns (uint128);
  function getLegacyId () external view returns (uint256);

  function LEGACY_TYPE() external view returns (uint128);

  function creator() external view returns (address);
  function router() external view returns (address);


  function delayLayer2() external view returns (uint256);

  function delayLayer3() external view returns (uint256);

  function activeLegacy(address guardAddress_, address[] calldata assets_, bool isETH_) external returns (address[] memory assets, uint8 layer);

  function checkActiveLegacy(address guardAddress_) external view returns (bool);

  function getDistribution(uint8 layer, address beneficiary) external returns (uint256);

  function getBeneficiaries() external view returns (address[] memory);

  function isLive() external view returns (bool);

  function getLegacyBeneficiaries()  external view returns (address [] memory beneficiaries, address layer2, address layer3);

  function getTriggerActivationTimestamp() external view returns(uint256 beneficiariesTrigger, uint256 layer2Trigger, uint256 layer3Trigger);

  function getLayer()  external view returns (uint8);

  function getLegacyName() external view returns (string memory);

  function getLastTimestamp() external view returns (uint256);

  function getBeneficiaryLayer(address beneficiary) external view returns (uint8);

  function getBeneNickname(address beneAddress) external view returns (string memory);

}
