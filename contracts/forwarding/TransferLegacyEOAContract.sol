// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {GenericLegacy} from "../common/GenericLegacy.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";
import {IPremiumSetting} from "../interfaces/IPremiumSetting.sol";
import {ITransferEOALegacy} from "../interfaces/ITransferLegacyEOAContract.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {IPayment} from "../interfaces/IPayment.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {NotifyLib} from "../libraries/NotifyLib.sol";
import {IWETH} from "../interfaces/IWETH.sol";

contract TransferEOALegacy is GenericLegacy, ITransferEOALegacy {
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
  error BeneficiariesIsClaimed();
  error LegacyIsDeleted();
  error SafeTransfromFailed(address, address, address);
  error NotEnoughETH();
  error LayerInvalid();
  error NotPremium();
  error NeedtoSetLayer2();
  error AlreadyBeneficiary();
  error DelayAndDistributionInvalid();
  error SwapFailed();
  error InvalidPaymentContract();

  /* State variable */
  uint128 public constant LEGACY_TYPE = 3;
  uint128 public constant MAX_TRANSFER = 10;
  uint256 public adminFeePercent; // Store fee percentage at initialization
  address public paymentContract; // Store address for fee transfers
  address public uniswapRouter; // Uniswap router address for swapping
  address public weth; // WETH address for swapping

  uint256 private _lastTimestamp;
  uint256 private _isLive = 1;

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
  address public eoaStorageToken; // address(0) means no active swap

  modifier onlyLive() {
    if (!isLive()) {
      revert LegacyIsDeleted();
    }
    _;
  }

  function _swapAdminFee(address token, uint256 amountIn) internal {
    if (uniswapRouter == address(0) || weth == address(0) || paymentContract == address(0)) {
      revert InvalidPaymentContract();
    }

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

  /**
   * @dev Owner swaps ETH (sent as msg.value) into a storage token via Uniswap V2.
   * The resulting tokens are sent directly to the owner's wallet, not held by this contract.
   * Sets eoaStorageToken so the system knows a swap is active.
   */
  function autoSwap(
    address sender_,
    TransferLegacyStruct.EOALegacyETHSwap calldata swap_
  ) external payable onlyRouter onlyLive onlyOwner(sender_) {
    if (msg.value == 0) revert NotEnoughETH();
    if (swap_.storageToken == address(0)) revert AssetInvalid();

    if (swap_.storageToken == weth) {
      // ETH→WETH is 1:1 wrap; bypass Uniswap
      IWETH(weth).deposit{value: msg.value}();
      IERC20(weth).safeTransfer(sender_, msg.value);
    } else {
      address[] memory path = new address[](2);
      path[0] = weth;
      path[1] = swap_.storageToken;

      IUniswapV2Router02(uniswapRouter).swapExactETHForTokens{value: msg.value}(
        swap_.amountOutMin,
        path,
        sender_,
        swap_.deadline
      );
    }

    eoaStorageToken = swap_.storageToken;
    _lastTimestamp = block.timestamp;
  }

  /**
   * @dev Owner reverses a previous autoSwap: pulls storage token from owner's wallet
   * (requires prior ERC-20 approval), swaps back to ETH via Uniswap V2, sends ETH to owner.
   * Clears eoaStorageToken on completion.
   */
  function unswap(
    address sender_,
    uint256 amountIn_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external onlyRouter onlyLive onlyOwner(sender_) {
    if (eoaStorageToken == address(0)) revert AssetInvalid();
    if (amountIn_ == 0) revert AssetInvalid();

    IERC20(eoaStorageToken).safeTransferFrom(sender_, address(this), amountIn_);
    IERC20(eoaStorageToken).forceApprove(uniswapRouter, amountIn_);

    address[] memory path = new address[](2);
    path[0] = eoaStorageToken;
    path[1] = weth;

    IUniswapV2Router02(uniswapRouter).swapExactTokensForETH(
      amountIn_,
      amountOutMin_,
      path,
      sender_,
      deadline_
    );

    eoaStorageToken = address(0);
    _lastTimestamp = block.timestamp;
  }

  /* View functions to support premium */
  function isLive() public view override returns (bool) {
    return (_isLive == 1) && (getIsActiveLegacy() == 1);
  }

  function getTriggerActivationTimestamp() public view override returns (uint256, uint256, uint256) {
    uint256 lackOfOutgoingTxRange = uint256(getActivationTrigger());
    uint256 beneficiariesTrigger = _lastTimestamp + lackOfOutgoingTxRange;
    uint256 layer2Trigger = beneficiariesTrigger + delayLayer2;
    uint256 layer3Trigger = layer2Trigger + delayLayer3;
    return (beneficiariesTrigger, layer2Trigger, layer3Trigger);
  }

  function getLegacyBeneficiaries() public view override returns (address[] memory, address, address) {
    return (_beneficiariesSet.values(), _layer2Beneficiary, _layer3Beneficiary);
  }

  function getLayer() public view override(GenericLegacy, ITransferEOALegacy) returns (uint8) {
    return getCurrentLayer();
  }

  function getLastTimestamp() public view override returns (uint256) {
    return _lastTimestamp;
  }

  /* View function */
  function getBeneficiaries(address bene_) public view returns (address[] memory) {
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

  function getCurrentLayer() internal view returns (uint8) {
    uint256 ts = block.timestamp;
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
   * @return bool true if eligible for activation, false otherwise
   */
  function checkActiveLegacy() external view returns (bool) {
    return _checkActiveLegacy();
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
    address _paymentContract,
    address _uniswapRouter,
    address _weth,
    string[] calldata nicknames,
    string calldata nickname2,
    string calldata nickname3
  ) external notInitialized returns (uint256 numberOfBeneficiaries) {
    if (owner_ == address(0)) revert OwnerInvalid();
    uniswapRouter = _uniswapRouter;
    weth = _weth;
    _setLegacyInfo(legacyId_, owner_, 1, config_.lackOfOutgoingTxRange, msg.sender);
    premiumSetting = IPremiumSetting(_premiumSetting);
    paymentContract = _paymentContract;
    adminFeePercent = IPayment(paymentContract).getFee();
    if (adminFeePercent > 10000) revert PercentInvalid();
    creator = owner_;

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
      _setLayer23Distributions(2, nickname2, layer2Distribution_);
      _setLayer23Distributions(3, nickname3, layer3Distribution_);
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
    }

    numberOfBeneficiaries = _setDistributions(owner_, distributions_, nicknames);
    _lastTimestamp = block.timestamp;
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

  function setLayer23Distributions(
    address sender_,
    uint8 layer_,
    string calldata nickname,
    TransferLegacyStruct.Distribution calldata distribution_
  ) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    if (layer_ < 2 || layer_ > 3) revert LayerInvalid();
    if (distribution_.user == address(0)) revert DistributionUserInvalid();
    if (!premiumSetting.isPremium(sender_)) revert NotPremium();

    _setLayer23Distributions(layer_, nickname, distribution_);
    if (!_checkDelayAndDistribution()) revert DelayAndDistributionInvalid();
    _lastTimestamp = block.timestamp;

  }

  function setDelayLayer23(address sender_, uint256 delayLayer2_, uint256 delayLayer3_) external onlyRouter onlyOwner(sender_) isActiveLegacy {
    if (!premiumSetting.isPremium(sender_)) revert NotPremium();
    delayLayer2 = delayLayer2_;
    delayLayer3 = delayLayer3_;
    if (!_checkDelayAndDistribution()) revert DelayAndDistributionInvalid();
    _lastTimestamp = block.timestamp;

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
  ) external onlyRouter onlyLive onlyOwner(sender_) isActiveLegacy returns (uint256 numberOfBeneficiaries) {
    _clearDistributions();
    numberOfBeneficiaries = _setDistributions(sender_, distributions_, nicknames_);

    _lastTimestamp = block.timestamp;
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
    bool isPremium = premiumSetting.isPremium(sender_);

    if (!isPremium) {
      //For non-premium users, only allow setting to default values
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

    _lastTimestamp = block.timestamp;
  }

  /**
   * @dev Set lackOfOutgoingTxRange legacy
   * @param sender_  sender
   * @param lackOfOutgoingTxRange_  lackOfOutgoingTxRange
   */
  function setActivationTrigger(address sender_, uint256 lackOfOutgoingTxRange_) external onlyRouter onlyLive onlyOwner(sender_) isActiveLegacy {
    _setActivationTrigger(lackOfOutgoingTxRange_);

    _lastTimestamp = block.timestamp;
  }

  /**
   * @dev mark to the owner is still alive
   */
  function activeAlive(address sender_) external onlyRouter onlyLive onlyOwner(sender_) isActiveLegacy {
    _lastTimestamp = block.timestamp;
  }

  function deleteLegacy(address sender_) external onlyRouter onlyLive onlyOwner(sender_) isActiveLegacy {
    _isLive = 2;
    _lastTimestamp = block.timestamp;

    payable(sender_).transfer(address(this).balance);
  }

  receive() external payable {
    if (isLive() && msg.sender == getLegacyOwner()) {
      _lastTimestamp = block.timestamp;
    }
  }

  /**
   * @dev withdraw ETH
   */
  function withdraw(address sender_, uint256 amount_) external onlyRouter onlyLive onlyOwner(sender_) {
    if (address(this).balance < amount_) {
      revert NotEnoughETH();
    }
    _lastTimestamp = block.timestamp;
    payable(sender_).transfer(amount_);
  }

  /**
   * @param assets_ erc20 token list
   * @param isETH_ is native token
   */
  function activeLegacy(address[] calldata assets_, bool isETH_, address bene) external onlyRouter  {
    if (_checkActiveLegacy() && _isLive == 1) {
      if (getIsActiveLegacy() == 1) {
        _setLegacyToInactive();
      }
      _transferAssetToBeneficiaries(assets_, isETH_, bene);
    } else {
      revert NotEnoughContitionalActive();
    }
  }

  /**
   * @dev Beneficiary claims the legacy, atomically swapping the storage token back to ETH first.
   * If eoaStorageToken == address(0) the function behaves identically to activeLegacy with isETH_=true.
   * ETH from the swap is received by this contract (via receive()) and then distributed proportionally
   * to all beneficiaries by the existing _transferAssetToBeneficiaries logic.
   * @param assets_       ERC-20 token addresses to distribute from the owner's wallet
   * @param bene_         The beneficiary address (caller, forwarded from router)
   * @param amountOutMin_ Minimum ETH out from the swap (0 = no slippage check, acceptable at claim time)
   * @param deadline_     Uniswap swap deadline (unix timestamp)
   */
  function activeLegacyAndUnswap(
    address[] calldata assets_,
    address bene_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external onlyRouter {
    if (!(_checkActiveLegacy() && _isLive == 1)) revert NotEnoughContitionalActive();

    if (eoaStorageToken != address(0)) {
      address ownerAddress = getLegacyOwner();
      uint256 tokenBal = IERC20(eoaStorageToken).balanceOf(ownerAddress);
      uint256 allowance = IERC20(eoaStorageToken).allowance(ownerAddress, address(this));
      uint256 pullAmount = tokenBal < allowance ? tokenBal : allowance;
      if (pullAmount > 0) {
        IERC20(eoaStorageToken).safeTransferFrom(ownerAddress, address(this), pullAmount);
        if (eoaStorageToken == weth) {
          // WETH→ETH is 1:1 unwrap; bypass Uniswap
          IWETH(weth).withdraw(pullAmount);
        } else {
          IERC20(eoaStorageToken).forceApprove(uniswapRouter, pullAmount);
          address[] memory path = new address[](2);
          path[0] = eoaStorageToken;
          path[1] = weth;
          IUniswapV2Router02(uniswapRouter).swapExactTokensForETH(
            pullAmount,
            amountOutMin_,
            path,
            address(this), // ETH lands here; receive() now accepts it unconditionally
            deadline_
          );
        }
      }
      eoaStorageToken = address(0);
    }

    if (getIsActiveLegacy() == 1) {
      _setLegacyToInactive();
    }

    _transferAssetToBeneficiaries(assets_, true, bene_);
  }

  function setLegacyName(string calldata legacyName_, address sender_) external onlyRouter onlyLive onlyOwner(sender_){
    _setLegacyName(legacyName_);
    _lastTimestamp = block.timestamp;

  }

  /* Utils function */

  /**
   * @dev Check activation conditions
   * @return bool true if eligible for activation, false otherwise
   */
  function _checkActiveLegacy() private view returns (bool) {
    uint256 lackOfOutgoingTxRange = getActivationTrigger();
    if (_lastTimestamp + lackOfOutgoingTxRange > block.timestamp) {
      return false;
    }
    return true;
  }

  /**
   * @dev set ditribution list
   * @param owner_ address
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
   * @param owner_ owner legacy
   * @param distribution_ distribution
   */
  function _checkDistribution(address owner_, TransferLegacyStruct.Distribution calldata distribution_) private view {
    if (distribution_.percent == 0 || distribution_.percent > MAX_PERCENT) revert DistributionAssetInvalid();
    if (distribution_.user == address(0) || distribution_.user == owner_) revert DistributionAssetInvalid();
  }

  /**
   * @dev transfer asset to beneficiaries
   */
  function _transferAssetToBeneficiaries(address[] calldata assets_, bool isETH_, address bene_) private {
    address ownerAddress = getLegacyOwner();
    address[] memory beneficiaries = getBeneficiaries(bene_);
    uint8 beneLayer = getBeneficiaryLayer(bene_);
    uint256 n = assets_.length;
    uint256 maxTransfer = MAX_TRANSFER;

    if (isETH_) {
      maxTransfer = maxTransfer - beneficiaries.length;
    }
    //actual number of assets claimed in this tranasaction
    bool isRemaining = false;
    if (n * beneficiaries.length > maxTransfer) {
      n = maxTransfer / beneficiaries.length;
      isRemaining = true;
    }

    //prepare data to send mail
    NotifyLib.BeneReceived[] memory receipt = new NotifyLib.BeneReceived[](beneficiaries.length);
    NotifyLib.ListAsset[] memory summary = new NotifyLib.ListAsset[](n + 1);
    for (uint256 i = 0; i < beneficiaries.length; i++) {
      receipt[i].beneAddress = beneficiaries[i];
      receipt[i].name = getBeneNickname(beneficiaries[i]);
      string[] memory listAssetName = new string[](n + 1); // +1 for ETH
      uint256[] memory listAmount = new uint256[](n + 1);
      receipt[i].listAssetName = listAssetName;
      receipt[i].listAmount = listAmount;
    }
    if (isETH_) {
      uint256 totalAmountEth = address(this).balance;
      summary[n] = NotifyLib.ListAsset({listToken: address(0), listAmount: totalAmountEth, listAssetName: "ETH"});
      if (totalAmountEth > 0) {
        uint256 fee = (totalAmountEth * adminFeePercent) / 10000;
        uint256 distributableEth = totalAmountEth - fee;
        if (fee > 0) {
          _transferEthToBeneficiary(paymentContract, fee);
        }

        uint256 processedAmountETH = 0;
        for (uint256 i = 0; i < beneficiaries.length ; ) {
          uint256 amount = i != beneficiaries.length - 1
            ? (distributableEth * getDistribution(beneLayer, beneficiaries[i])) / MAX_PERCENT
            : distributableEth - processedAmountETH;
          uint256 sentAmount = _transferEthToBeneficiary(beneficiaries[i], amount);
          processedAmountETH += amount;
          receipt[i].listAssetName[n] = "ETH";
          receipt[i].listAmount[n] = sentAmount;
          unchecked {
            i++;
          }
        }
      }
    }

    for (uint256 i = 0; i < n; ) {
      address token = assets_[i];
      // If this token is the storage-token being claimed directly, clear the flag.
      if (token == eoaStorageToken) {
        eoaStorageToken = address(0);
      }
      uint256 allowanceAmountErc20 = IERC20(token).allowance(ownerAddress, address(this));
      uint256 balanceAmountErc20 = IERC20(token).balanceOf(ownerAddress);
      uint256 totalAmount = balanceAmountErc20 > allowanceAmountErc20 ? allowanceAmountErc20 : balanceAmountErc20;
      if (totalAmount > 0) {
        string memory symbol = IERC20Metadata(token).symbol();
        summary[i] = NotifyLib.ListAsset({listToken: token, listAmount: totalAmount, listAssetName: symbol});

        uint256 fee = (totalAmount * adminFeePercent) / 10000;
        uint256 distributable = totalAmount - fee;
      
        if (fee > 0) {
          uint256 balanceBefore = IERC20(token).balanceOf(address(this));
          IERC20(token).safeTransferFrom(ownerAddress, address(this), fee);
          uint256 actualFeeReceived =  IERC20(token).balanceOf(address(this)) - balanceBefore;
          _swapAdminFee(token, actualFeeReceived);
        }
        
        uint256 processedAmountERC20 = 0;
        for (uint256 j = 0; j < beneficiaries.length; ) {
          uint256 amount = j != beneficiaries.length - 1
            ? (distributable * getDistribution(beneLayer, beneficiaries[j])) / MAX_PERCENT
            : distributable - processedAmountERC20;
          uint256 amountSent = _transferErc20ToBeneficiary(token, ownerAddress, beneficiaries[j], amount);
          receipt[j].listAssetName[i] = symbol;
          receipt[j].listAmount[i] = amountSent;
          processedAmountERC20 += amount;

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
    IPremiumSetting(premiumSetting).triggerActivationTransferLegacy(
      summary,
      receipt,
      isRemaining
    )
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
  function _transferErc20ToBeneficiary(address erc20Address_, address from_, address to_, uint256 amount_) private returns(uint256 amountSent) {
    try 
    IERC20(erc20Address_).transferFrom(from_, to_, amount_) {
      return amount_;
    } catch {
      return 0;
    }
  }

 /**
 * @dev transfer eth to beneficiaries
 * @param to_ beneficiary address
 * @param amount_ amount of ETH to send
 * @return amountSent amount actually sent (0 if failed)
 */
function _transferEthToBeneficiary(address to_, uint256 amount_) 
    private 
    returns (uint256 amountSent) 
{
    (bool success, ) = payable(to_).call{value: amount_}("");
    return success ? amount_ : 0;
}
}
