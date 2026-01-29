// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/libraries/Enum.sol";

import {GenericLegacy} from "../common/GenericLegacy.sol";

import {ISafeGuard} from "../interfaces/ISafeGuard.sol";
import {ISafeWallet} from "../interfaces/ISafeWallet.sol";
import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";

import {IPremiumSetting} from "../interfaces/IPremiumSetting.sol";
import {ITransferLegacy} from "../interfaces/ITransferLegacyContract.sol";
import {IPayment} from "../interfaces/IPayment.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {NotifyLib} from "../libraries/NotifyLib.sol";

contract TransferLegacy is GenericLegacy, ITransferLegacy {
  using EnumerableSet for EnumerableSet.AddressSet;
  using SafeERC20 for IERC20;
  /* Error */
  error NotBeneficiary();
  error DistributionUserInvalid();
  error DistributionAssetInvalid();
  error AssetInvalid();
  error PercentInvalid();
  error NotEnoughContitionalActive();
  error ExecTransactionFromModuleFailed();
  error LayerInvalid();
  error NotPremium();
  error NeedtoSetLayer2();
  error AlreadyBeneficiary();
  error DelayAndDistributionInvalid();
  error InvalidGuard();
  /* State variable */
  uint128 public constant LEGACY_TYPE = 2;
  uint128 public constant MAX_TRANSFER =  2;
  uint256 public adminFeePercent;
  address public paymentContract;

  EnumerableSet.AddressSet private _beneficiariesSet;
  mapping(address beneficiaries => uint256) private _distributions;
  address private _layer2Beneficiary;
  uint256 private _layer2Distribution;
  address private _layer3Beneficiary;
  uint256 private _layer3Distribution;

  uint256 public delayLayer2;
  uint256 public delayLayer3;

  IPremiumSetting public premiumSetting;
  address public creator;
  address public safeGuard;
  address public uniswapRouter; // Uniswap router address for swapping
  address public weth; // WETH address for swapping

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
    uint256 lackOfOutgoingTxRange = uint256(getActivationTrigger());
    uint256 beneficiariesTrigger = lastTimestamp + lackOfOutgoingTxRange;
    uint256 layer2Trigger = beneficiariesTrigger + delayLayer2;
    uint256 layer3Trigger = layer2Trigger + delayLayer3;

    return (beneficiariesTrigger, layer2Trigger, layer3Trigger);
  }

  function getLegacyBeneficiaries() public view override returns (address[] memory, address, address) {
    return (_beneficiariesSet.values(), _layer2Beneficiary, _layer3Beneficiary);
  }

  function getLayer() public view override(GenericLegacy, ITransferLegacy) returns (uint8) {
    return getCurrentLayer(safeGuard);
  }

  function getLastTimestamp() public view override returns (uint256) {
    return ISafeGuard(safeGuard).getLastTimestampTxs();
  }

  function _swapAdminFee(address token, uint256 amountIn) internal {
    // Approve token for router
    IERC20(token).forceApprove(uniswapRouter, amountIn);

    address[] memory path = new address[](2);
    path[0] = token;
    path[1] = weth;

    try
      IUniswapV2Router02(uniswapRouter).swapExactTokensForETH(
        amountIn,
        0, // accept any amount of ETH
        path,
        paymentContract,
        block.timestamp + 300
      )
    {} catch {
      IERC20(token).safeTransfer(paymentContract, amountIn);
    }
  }

  /* View function */
  /**
   * @dev get beneficiaries list
   */
  function getBeneficiaries(address bene_) internal view returns (address[] memory) {
    uint8 currentLayer_ = getBeneficiaryLayer(bene_);
    if (currentLayer_ == 1) return _beneficiariesSet.values();
    else if (currentLayer_ == 2) {
      address[] memory beneficiaries = new address[](1);
      beneficiaries[0] = _layer2Beneficiary;
      return beneficiaries;
    } else if (currentLayer_ == 3) {
      address[] memory beneficiaries = new address[](1);
      beneficiaries[0] = _layer3Beneficiary;
      return beneficiaries;
    } else revert LayerInvalid();
  }

  function getDistribution(uint8 layer, address beneficiary) public view returns (uint256) {
    if (layer == 1) {
      return _distributions[beneficiary];
    } else if (layer == 2) {
      if (beneficiary == _layer2Beneficiary) {
        return _layer2Distribution;
      } else {
        return 0;
      }
    } else if (layer == 3) {
      if (beneficiary == _layer3Beneficiary) {
        return _layer3Distribution;
      } else {
        return 0;
      }
    } else {
      return 0;
    }
  }

  /**
   * @dev Get the layer of a specific beneficiary
   * @param beneficiary The address of the beneficiary
   * @return uint8 The layer of the beneficiary (1 for First-line, 2 for Second-line, 3 for Third-line, 0 if not a beneficiary)
   */
  function getBeneficiaryLayer(address beneficiary) public view returns (uint8) {
    if (_distributions[beneficiary] > 0) {
      return 1;
    } else if (beneficiary == _layer2Beneficiary && _layer2Distribution > 0) {
      return 2;
    } else if (beneficiary == _layer3Beneficiary && _layer3Distribution > 0) {
      return 3;
    }
    return 0;
  }

  function getCurrentLayer(address guardAddress_) internal view returns (uint8) {
    uint256 ts = block.timestamp;
    uint256 _lastTimestamp = ISafeGuard(guardAddress_).getLastTimestampTxs();
    uint256 lackOfOutgoingTxRange = getActivationTrigger();
    uint256 base = (_lastTimestamp + lackOfOutgoingTxRange);
    if (ts >= base + delayLayer2 + delayLayer3 && delayLayer3 != 0) {
      return 3;
    } else if (ts >= base + delayLayer2 && delayLayer2 != 0) {
      return 2;
    } else {
      return 1;
    }
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
   * @dev Intialize info legacy
   * @param legacyId_ legacy id
   * @param owner_ owner of legacy
   * @param distributions_ ditributions list
   * @param config_ include lackOfOutgoingTxRange
   */
  function initialize(
    uint256 legacyId_,
    address owner_,
    TransferLegacyStruct.Distribution[] calldata distributions_,
    TransferLegacyStruct.LegacyExtraConfig calldata config_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    address _premiumSetting,
    address _creator,
    address _safeGuard,
    address _uniswapRouter,
    address _weth,
    address _paymentContract,
    string[] calldata nicknames,
    string calldata nickName2,
    string calldata nickName3
  ) external notInitialized returns (uint256 numberOfBeneficiaries) {
    // if (owner_ == address(0)) revert OwnerInvalid();
    _setLegacyInfo(legacyId_, owner_, 1, config_.lackOfOutgoingTxRange, msg.sender);
    uniswapRouter = _uniswapRouter;
    weth = _weth;
    premiumSetting = IPremiumSetting(_premiumSetting);
    creator = _creator;
    safeGuard = _safeGuard;
    paymentContract = _paymentContract;
    adminFeePercent = IPayment(_paymentContract).getFee(); //always <= 10000

    // Check duplicates across layers BEFORE setting anything
    address l2User = layer2Distribution_.user;
    address l3User = layer3Distribution_.user;

    for (uint256 i = 0; i < distributions_.length; ++i) {
      address user = distributions_[i].user;
      if (user == address(0)) continue;

      if (user == l2User || user == l3User) {
        revert AlreadyBeneficiary();
      }
    }

    if (premiumSetting.isPremium(creator)) {
      delayLayer2 = config_.delayLayer2;
      delayLayer3 = config_.delayLayer3;
      _setLayer23Distributions(2, nickName2, layer2Distribution_);
      _setLayer23Distributions(3, nickName3, layer3Distribution_);
      if (!_checkDelayAndDistribution()) revert DelayAndDistributionInvalid();
    } else {
      // Check input values before assigning them to state
      if (
        config_.delayLayer2 != 0 ||
        config_.delayLayer3 != 0 ||
        layer2Distribution_.percent != 0 ||
        layer3Distribution_.percent != 0 ||
        layer2Distribution_.user != address(0) ||
        layer3Distribution_.user != address(0)
      ) {
        revert NotPremium();
      }

      // Do not assign state variables
    }

    numberOfBeneficiaries = _setDistributions(owner_, distributions_, nicknames);
  }

  function _checkDelayAndDistribution() internal view returns (bool) {
    // Case 1: All default values (for non-premium users)
    if (delayLayer2 == 0 && _layer2Distribution == 0 && delayLayer3 == 0 && _layer3Distribution == 0) {
      return true;
    }

    // Case 2: Only layer2 is set (premium users)
    if (delayLayer2 != 0 && _layer2Distribution == MAX_PERCENT && delayLayer3 == 0 && _layer3Distribution == 0) {
      return true;
    }

    // Case 3: Both layers are set (premium users)
    if (delayLayer2 != 0 && _layer2Distribution == MAX_PERCENT && delayLayer3 != 0 && _layer3Distribution == MAX_PERCENT) {
      return true;
    }

    return false;
  }

  function _setLayer23Distributions(uint8 layer_, string calldata nickname, TransferLegacyStruct.Distribution calldata distribution_) private {
    uint256 _distributionPercentage;
    address _beneficiary;
    if (distribution_.percent == 0) {
      _distributionPercentage = 0;
      _beneficiary = address(0);
    } else {
      _distributionPercentage = MAX_PERCENT;
      if (distribution_.user == address(0)) revert DistributionUserInvalid();
      _beneficiary = distribution_.user;
    }
    if (layer_ == 2) {
      if (_distributions[distribution_.user] != 0) revert AlreadyBeneficiary();
      _deleteBeneName(_layer2Beneficiary);
      _layer2Beneficiary = _beneficiary;
      _layer2Distribution = _distributionPercentage;
      _setBeneNickname(_layer2Beneficiary, nickname);
    } else {
      if (_layer2Distribution != MAX_PERCENT && _distributionPercentage != 0) revert NeedtoSetLayer2();
      if (_distributionPercentage != 0) {
        if (_layer2Distribution != MAX_PERCENT) revert NeedtoSetLayer2();
        if (_distributions[distribution_.user] != 0 || _layer2Beneficiary == distribution_.user) revert AlreadyBeneficiary();
      }
      _deleteBeneName(_layer3Beneficiary);
      _layer3Beneficiary = _beneficiary;
      _layer3Distribution = _distributionPercentage;
      _setBeneNickname(_layer3Beneficiary, nickname);
    }
  }

  /**
   * @dev set distributions[]
   * @param sender_  sender address
   * @param distributions_ ditributions
   */
  function setLegacyDistributions(
    address sender_,
    TransferLegacyStruct.Distribution[] calldata distributions_,
    string[] calldata nicknames_
  ) external onlyRouter onlyOwner(sender_) isActiveLegacy returns (uint256 numberOfBeneficiaries) {
    _clearDistributions();
    numberOfBeneficiaries = _setDistributions(sender_, distributions_, nicknames_);
  }

  function setDelayAndLayer23Distributions(
    address sender_,
    uint256 delayLayer2_,
    uint256 delayLayer3_,
    string calldata nickName2,
    string calldata nickName3,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_
  ) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    // Check if user is premium
    bool isPremium = premiumSetting.isPremium(creator);

    if (!isPremium) {
      // For non-premium users, only allow setting to default values
      if (
        delayLayer2_ != 0 ||
        delayLayer3_ != 0 ||
        layer2Distribution_.percent != 0 ||
        layer3Distribution_.percent != 0 ||
        layer2Distribution_.user != address(0) ||
        layer3Distribution_.user != address(0)
      ) {
        revert NotPremium();
      }
      // Don't change values for non-premium users
      return;
    }

    // For premium users, proceed with normal logic
    delayLayer2 = delayLayer2_;
    delayLayer3 = delayLayer3_;

    _setLayer23Distributions(2, nickName2, layer2Distribution_);

    bool skipCheck = true;
    if (layer3Distribution_.percent > 0 && layer3Distribution_.user != address(0)) {
      if (_layer2Beneficiary == layer3Distribution_.user || _distributions[layer3Distribution_.user] != 0) {
        revert AlreadyBeneficiary();
      }
      _deleteBeneName(_layer3Beneficiary);
      _layer3Beneficiary = layer3Distribution_.user;
      _layer3Distribution = MAX_PERCENT;
      _setBeneNickname(_layer3Beneficiary, nickName3);
      skipCheck = false;
    } else {
      _layer3Beneficiary = address(0);
      _layer3Distribution = 0;
    }

    if (!skipCheck && !_checkDelayAndDistribution()) {
      revert DelayAndDistributionInvalid();
    }
  }

  function setDelayLayer23(address sender_, uint256 delayLayer2_, uint256 delayLayer3_) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    if (premiumSetting.isPremium(sender_)) {
      delayLayer2 = delayLayer2_;
      delayLayer3 = delayLayer3_;
      if (!_checkDelayAndDistribution()) revert DelayAndDistributionInvalid();
    }
  }

  function setLayer23Distributions(
    address sender_,
    uint8 layer_,
    string calldata nickname,
    TransferLegacyStruct.Distribution calldata distribution_
  ) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    if (layer_ < 2 || layer_ > 3) revert LayerInvalid();
    if (distribution_.user == address(0)) revert DistributionUserInvalid();
    if (!premiumSetting.isPremium(creator)) revert NotPremium();

    _setLayer23Distributions(layer_, nickname, distribution_);
    if (!_checkDelayAndDistribution()) revert DelayAndDistributionInvalid();
  }

  /**
   * @dev Set lackOfOutgoingTxRange legacy
   * @param sender_  sender
   * @param lackOfOutgoingTxRange_  lackOfOutgoingTxRange
   */
  function setActivationTrigger(address sender_, uint256 lackOfOutgoingTxRange_) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    _setActivationTrigger(lackOfOutgoingTxRange_);
  }

  /**
   * @param guardAddress_  guard address
   */
  function activeLegacy(address guardAddress_, address[] calldata assets_, bool isETH_, address bene_) external onlyRouter {
    if (_checkActiveLegacy(guardAddress_)) {
      if (getIsActiveLegacy() == 1) {
        _setLegacyToInactive();
      }
      _transferAssetToBeneficiaries(assets_, isETH_, bene_);
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
    uint256 lackOfOutgoingTxRange = uint256(getActivationTrigger());
    if (lastTimestamp + lackOfOutgoingTxRange > block.timestamp) {
      return false;
    }
    return true;
  }

  /**
   * @dev set ditribution list
   * @param distributions_  distributions list
   * @return numberOfBeneficiaries number of beneficiaries
   */
  function _setDistributions(
    address owner_,
    TransferLegacyStruct.Distribution[] calldata distributions_,
    string[] calldata nicknames
  ) internal returns (uint256 numberOfBeneficiaries) {
    uint256 totalPercent = 0;
    for (uint256 i = 0; i < distributions_.length; ) {
      _checkDistribution(owner_, distributions_[i]);
      _beneficiariesSet.add(distributions_[i].user);
      _setBeneNickname(distributions_[i].user, nicknames[i]);
      _distributions[distributions_[i].user] = distributions_[i].percent;
      totalPercent += distributions_[i].percent;
      unchecked {
        i++;
      }
    }
    if (totalPercent != MAX_PERCENT) revert PercentInvalid();

    numberOfBeneficiaries = _beneficiariesSet.length();
  }

  /**
   * @dev clear distributions list
   */
  function _clearDistributions() internal {
    address[] memory beneficiaries = _beneficiariesSet.values();
    for (uint256 i = 0; i < beneficiaries.length; ) {
      _deleteBeneName(beneficiaries[i]);
      _beneficiariesSet.remove(beneficiaries[i]);
      _distributions[beneficiaries[i]] = 0;
      unchecked {
        i++;
      }
    }
  }

  /**
   * @dev check distribution
   * @param owner_ safe wallet address
   * @param distribution_ distribution
   */
  function _checkDistribution(address owner_, TransferLegacyStruct.Distribution calldata distribution_) private view {
    if (distribution_.percent == 0 || distribution_.percent > MAX_PERCENT) revert DistributionAssetInvalid();
    if (distribution_.user == address(0) || distribution_.user == owner_) revert DistributionUserInvalid();
  }

  /**
   * @dev transfer asset to beneficiaries
   */
  function _transferAssetToBeneficiaries(address[] calldata assets_, bool isETH_, address bene_) private {
    address safeAddress = getLegacyOwner();
    address[] memory beneficiaries = getBeneficiaries(bene_);
    uint8 beneLayer = getBeneficiaryLayer(bene_);
    uint256 n = assets_.length;
    uint256 maxTransfer = MAX_TRANSFER;

    if (isETH_) {
      maxTransfer = maxTransfer - beneficiaries.length;
    }
    //actual number of assets claimed in this tranasaction
    bool remaining = false;
    if (n * beneficiaries.length > maxTransfer) {
      n = maxTransfer / beneficiaries.length;
      remaining = true;
    }

    //prepare data to send mail
    NotifyLib.BeneReceived[] memory receipt = new NotifyLib.BeneReceived[](beneficiaries.length);
    NotifyLib.ListAsset[] memory summary = new NotifyLib.ListAsset[](n + 1);
    string memory symbol;
    for (uint256 i = 0; i < beneficiaries.length; ) {
      receipt[i].beneAddress = beneficiaries[i];
      receipt[i].name = getBeneNickname(beneficiaries[i]);
      string[] memory listAssetName = new string[](n + 1); // +1 for ETH
      uint256[] memory listAmount = new uint256[](n + 1);
      receipt[i].listAssetName = listAssetName;
      receipt[i].listAmount = listAmount;
      unchecked {
        i++;
      }
    }

    // Handle ETH transfer if isETH_ is true
    if (isETH_) {
      uint256 totalAmountEth = address(safeAddress).balance;
      if (totalAmountEth > 0) {
        uint256 fee = (totalAmountEth * adminFeePercent) / 10000;
        uint256 distributableEth = totalAmountEth - fee;
        if (fee > 0) _transferEthToBeneficiary(safeAddress, paymentContract, fee);

        symbol = "ETH";
        summary[n] = NotifyLib.ListAsset({listToken: address(0), listAmount: totalAmountEth, listAssetName: symbol});
        
        uint256 processedAmountETH = 0;
        for (uint256 i = 0; i < beneficiaries.length; ) {
          uint256 amount = i != beneficiaries.length - 1
            ? (distributableEth * getDistribution(beneLayer, beneficiaries[i])) / MAX_PERCENT
            : distributableEth-processedAmountETH;
          uint256 amountSent = _transferEthToBeneficiary(safeAddress, beneficiaries[i], amount);
          receipt[i].listAssetName[n] = symbol;
          receipt[i].listAmount[n] = amountSent;
          processedAmountETH+=amount;

          unchecked {
            i++;
          }
        }
      }
    }

    for (uint256 i = 0; i < n; ) {
      address token = assets_[i];
      uint256 totalAmountErc20 = IERC20(token).balanceOf(safeAddress);
      if (totalAmountErc20 > 0) {
        uint256 fee = (totalAmountErc20 * adminFeePercent) / 10000;
        uint256 distributable = totalAmountErc20 - fee;

        symbol = IERC20Metadata(token).symbol();
        summary[i] = NotifyLib.ListAsset({listToken: token, listAmount: totalAmountErc20, listAssetName: symbol});
        if (fee > 0) {
          uint256 balanceBefore = IERC20(token).balanceOf(address(this));
          _transferErc20ToBeneficiary(token, safeAddress, address(this), fee);
          uint256 actualFeeReceived =  IERC20(token).balanceOf(address(this)) - balanceBefore;
          _swapAdminFee(token, actualFeeReceived);
        }

        uint256 processedAmountERC20 = 0;
        for (uint256 j = 0; j < beneficiaries.length; ) {
          uint256 amount = j != beneficiaries.length - 1
            ? (distributable * getDistribution(beneLayer, beneficiaries[j])) / MAX_PERCENT
            : distributable - processedAmountERC20;
          if (amount > 0) {
            uint256 amountSent = _transferErc20ToBeneficiary(token, safeAddress, beneficiaries[j], amount);
            receipt[j].listAssetName[i] = symbol;
            receipt[j].listAmount[i] = amountSent;
            processedAmountERC20+=amount;
          }
          unchecked {
            j++;
          }
        }
      }

      unchecked {
        i++;
      }
    }
    // send email
    try 
    IPremiumSetting(premiumSetting).triggerActivationTransferLegacy(summary, receipt, remaining) 
    {} catch {
      emit EmailActivatedNotCompleted(address(this));
    }
  
  }
  /**
   * @dev transfer erc20 token to beneficiaries
   * @param erc20Address_  erc20 token address
   * @param from_ safe wallet address
   * @param to_ beneficiary address
   */
  function _transferErc20ToBeneficiary(address erc20Address_, address from_, address to_, uint256 amount) private returns(uint256 amountSent) {
    bytes memory transferErc20Data = abi.encodeWithSignature("transfer(address,uint256)", to_, amount);
    (bool transferErc20Success, bytes memory returnData) = ISafeWallet(from_).execTransactionFromModuleReturnData(
      erc20Address_,
      0,
      transferErc20Data,
      Enum.Operation.Call
    );

    if (!transferErc20Success || (returnData.length != 0 && !abi.decode(returnData, (bool)))) return 0;
    return amountSent;

  }

  /**
   * @dev transfer eth to beneficiaries
   * @param from_ safe wallet address
   * @param to_ beneficiary address
   */
  function _transferEthToBeneficiary(address from_, address to_, uint256 amount) private returns (uint256 amountSent) {
    bool transferEthSuccess = ISafeWallet(from_).execTransactionFromModule(to_, amount, "", Enum.Operation.Call);
    if (!transferEthSuccess) return 0;
    return amount;
  }
}
