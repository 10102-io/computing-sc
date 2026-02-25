// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";
interface ITransferEOALegacy {
  function creator() external view returns (address);

  function delayLayer2() external view returns (uint256);

  function delayLayer3() external view returns (uint256);

  function initialize(
    uint256 legacyId_,
    address owner_,
    TransferLegacyStruct.Distribution[] calldata distributions_,
    TransferLegacyStruct.LegacyExtraConfig calldata config_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    address _premiumSetting,
    address _paymentContract,
    address _router,
    address _weth,
    string[] calldata nicknames,
    string calldata nickName2,
    string calldata nickName3
  ) external returns (uint256 numberOfBeneficiaries);
  function setActivationTrigger(address sender_, uint256 lackOfOutgoingTxRange_) external;

  function setLegacyDistributions(
    address sender_,
    TransferLegacyStruct.Distribution[] calldata distributions_,
    string[] calldata nicknames
  ) external returns (uint256 numberOfBeneficiaries);

  function setDelayAndLayer23Distributions(
    address sender_,
    uint256 delayLayer2_,
    uint256 delayLayer3_,
    string calldata nickName2,
    string calldata nickName3,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_
  ) external;

  function activeAlive(address sender_) external;

  function activeLegacy(address[] calldata assets_, bool isETH_, address bene_) external;

  function deleteLegacy(address sender_) external;

  function withdraw(address sender_, uint256 amount_) external;

  function checkActiveLegacy() external view returns (bool);

  function getDistribution(uint8 layer, address beneficiary) external returns (uint256);

  function setLayer23Distributions(
    address sender_,
    uint8 layer_,
    string calldata nickname_,
    TransferLegacyStruct.Distribution calldata distribution_
  ) external;

  function setDelayLayer23(address sender_, uint256 delayLayer2_, uint256 delayLayer3_) external;

  function setLegacyName(string calldata legacyName_, address sender_) external;

  function getBeneficiaryLayer(address beneficiary) external view returns (uint8);

  function getLayer() external view returns (uint8);

  //function setSwapSettings(address _router, address _weth,address _paymentContract) external ;

  function eoaStorageToken() external view returns (address);

  function autoSwap(
    address sender_,
    TransferLegacyStruct.EOALegacyETHSwap calldata swap_
  ) external payable;

  function unswap(
    address sender_,
    uint256 amountIn_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external;
}
