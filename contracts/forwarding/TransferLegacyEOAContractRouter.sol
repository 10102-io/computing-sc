// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {LegacyRouter} from "../common/LegacyRouter.sol";
import {EOALegacyFactory} from "../common/EOALegacyFactory.sol";
import {ITransferEOALegacy} from "../interfaces/ITransferLegacyEOAContract.sol";
import {IPremiumLegacy} from "../interfaces/IPremiumLegacy.sol";
import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";
import {IEIP712LegacyVerifier} from "../interfaces/IEIP712LegacyVerifier.sol";
import {IPremiumSetting} from "../interfaces/IPremiumSetting.sol";
import {IPayment} from "../interfaces/IPayment.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";

contract TransferEOALegacyRouter is LegacyRouter, EOALegacyFactory, Initializable {
  address public premiumSetting;
  IEIP712LegacyVerifier public verifier;
  address public paymentContract;
  address public uniswapRouter;
  address public weth;
  bytes public legacyCreationCode;
  address private _codeAdmin;

  // EIP-1167 minimal-proxy implementation. When set (non-zero), new legacies are
  // created as clones pointing at this address instead of deploying the full
  // `legacyCreationCode` bytecode. Existing legacies are unaffected — they remain
  // full, independent contracts.
  address public legacyImplementation;

  /* Error */
  error NumBeneficiariesInvalid();
  error NumAssetsInvalid();
  error DistributionsInvalid();
  error ActivationTriggerInvalid();
  error SenderIsCreatedLegacy(address);
  error OnlyBeneficaries();
  error CannotClaim();
  error InvalidSwapSettings();
  error NotCodeAdmin();
  error EmptyCode();
  error OnlyOwner();
  error LegacyStillActive();

  modifier onlyCodeAdmin() {
    if (msg.sender != _codeAdmin) revert NotCodeAdmin();
    _;
  }

  /* Struct */
  struct LegacyMainConfig {
    string name;
    string note;
    string[] nickNames;
    TransferLegacyStruct.Distribution[] distributions;
  }

  /* Event */
  event TransferEOALegacyCreated(
    uint256 indexed legacyId,
    address legacyAddress,
    address creatorAddress,
    LegacyMainConfig mainConfig,
    TransferLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );
  event TransferEOALegacyConfigUpdated(
    uint256 indexed legacyId,
    LegacyMainConfig mainConfig,
    TransferLegacyStruct.LegacyExtraConfig extraConfig,
    uint256 timestamp
  );
  event TransferEOALegacyDistributionUpdated(
    uint256 indexed legacyId,
    string[] nickNames,
    TransferLegacyStruct.Distribution[] distributions,
    uint256 timestamp
  );
  event TransferEOALegacyTriggerUpdated(uint256 indexed legacyId, uint128 lackOfOutgoingTxRange, uint256 timestamp);
  event TransferEOALegacyNameNoteUpdated(uint256 indexed legacyId, string name, string note, uint256 timestamp);
  event TransferEOALegacyActivated(uint256 indexed legacyId, uint8 layer, uint256 timestamp);
  event TransferEOALegacyActivedAlive(uint256 indexed legacyId, uint256 timestamp);
  event TransferEOALegacyDeleted(uint256 indexed legacyId, uint256 timestamp);
  event TransferEOALegacyLayer23DistributionUpdated(
    uint256 indexed legacyId,
    uint8 layer,
    string nickNames,
    TransferLegacyStruct.Distribution distribution,
    uint256 timestamp
  );
  event TransferEOALegacyLayer23Created(uint256 indexed legacyId, uint8 layer, TransferLegacyStruct.Distribution distribution, string nickName);
  event EmailOwnerResetNotCompleted(address legacyAddress);
  event TransferEOALegacyAutoSwapped(uint256 indexed legacyId, address storageToken, uint256 ethAmount, uint256 timestamp);
  event TransferEOALegacyUnswapped(uint256 indexed legacyId, address storageToken, uint256 tokenAmount, uint256 timestamp);
  event TransferEOALegacyActivatedWithUnswap(uint256 indexed legacyId, uint8 layer, uint256 timestamp);
  event TransferEOALegacyCreateFlagReleased(uint256 indexed legacyId, address indexed owner, uint256 timestamp);

    constructor () {
    _disableInitializers();
  }

  function initialize(
    address _deployerContract,
    address _premiumSetting,
    address _verifier,
    address _paymentContract,
    address router_,
    address weth_
  ) external initializer {
    if (
      _deployerContract == address(0) ||
      _premiumSetting == address(0) ||
      _verifier == address(0) ||
      _paymentContract == address(0) ||
      router_ == address(0) ||
      weth_ == address(0)
    ) revert InvalidInitialization();
    legacyDeployerContract = _deployerContract;
    premiumSetting = _premiumSetting;
    verifier = IEIP712LegacyVerifier(_verifier);
    paymentContract = _paymentContract;
    uniswapRouter = router_;
    weth = weth_;
  }

  function initializeV2(address codeAdmin_) external reinitializer(3) {
    if (codeAdmin_ == address(0)) revert InvalidInitialization();
    _codeAdmin = codeAdmin_;
  }

  // Additional rotation path for proxies whose `_initialized` counter has
  // already advanced past 3 due to a prior reinitialization cycle performed on
  // an earlier implementation. Use this when `initializeV2` is no longer
  // callable (e.g. mainnet as of the EIP-1167 upgrade). Must be called
  // atomically with the proxy upgrade (e.g. via `admin.upgradeAndCall`) to
  // prevent any window for front-running.
  function initializeV3(address codeAdmin_) external reinitializer(4) {
    if (codeAdmin_ == address(0)) revert InvalidInitialization();
    _codeAdmin = codeAdmin_;
  }


  function setLegacyCreationCode(bytes calldata code_) external onlyCodeAdmin {
    if (code_.length == 0) revert EmptyCode();
    legacyCreationCode = code_;
  }

  /**
   * @dev Point new legacies at an EIP-1167 minimal-proxy implementation. Once set,
   * `createLegacy` deploys ~45-byte clones (~40k gas) instead of the full ~18KB
   * bytecode (~6M gas). Pass `address(0)` to fall back to the legacy bytecode path.
   * Existing legacies are unaffected by this change.
   */
  function setLegacyImplementation(address impl_) external onlyCodeAdmin {
    legacyImplementation = impl_;
  }

  /**
   * @dev Get next legacy address that would be created for a sender. Uses the
   * clone prediction when `legacyImplementation` is set, otherwise falls back to
   * the creation-code prediction.
   */
  function getNextLegacyAddress(address sender_) external view returns (address) {
    if (legacyImplementation != address(0)) {
      return _getNextCloneAddress(legacyImplementation, sender_);
    }
    return _getNextAddress(legacyCreationCode, sender_);
  }

  function checkActiveLegacy(uint256 legacyId_) external view returns (bool) {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    return ITransferEOALegacy(legacyAddress).checkActiveLegacy();
  }

  function createLegacy(
    LegacyMainConfig calldata mainConfig_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    string calldata nickName2,
    string calldata nickName3,
    uint256 signatureTimestamp,
    bytes calldata agreementSignature
  ) external returns (address) {
    if (mainConfig_.distributions.length != mainConfig_.nickNames.length || mainConfig_.distributions.length == 0) revert DistributionsInvalid();
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();
    //Check if msg.sender has already created a legacy
    if (_isCreateLegacy(msg.sender)) revert SenderIsCreatedLegacy(msg.sender);

    // Create new legacy contract. Clone path (EIP-1167) when an implementation
    // is configured, otherwise full-bytecode deploy for back-compat.
    (uint256 newLegacyId, address legacyAddress) = legacyImplementation != address(0)
      ? _cloneLegacy(legacyImplementation, msg.sender)
      : _createLegacy(legacyCreationCode, msg.sender);

    //Verify + store user agreement signature
    verifier.storeLegacyAgreement(msg.sender, legacyAddress, signatureTimestamp, agreementSignature);

    uint256 numberOfBeneficiaries = ITransferEOALegacy(legacyAddress).initialize(
      newLegacyId,
      msg.sender,
      mainConfig_.distributions,
      extraConfig_,
      layer2Distribution_,
      layer3Distribution_,
      premiumSetting,
      paymentContract,
      uniswapRouter,
      weth,
      mainConfig_.nickNames,
      nickName2,
      nickName3
    );

    // Check beneficiary limit
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    TransferLegacyStruct.LegacyExtraConfig memory _legacyExtraConfig = TransferLegacyStruct.LegacyExtraConfig({
      lackOfOutgoingTxRange: extraConfig_.lackOfOutgoingTxRange,
      delayLayer2: ITransferEOALegacy(legacyAddress).delayLayer2(),
      delayLayer3: ITransferEOALegacy(legacyAddress).delayLayer3()
    });

    ITransferEOALegacy(legacyAddress).setLegacyName(mainConfig_.name, msg.sender);

    emit TransferEOALegacyCreated(newLegacyId, legacyAddress, msg.sender, mainConfig_, _legacyExtraConfig, block.timestamp);

    //set private code for legacy of premium user
    IPremiumSetting(premiumSetting).setPrivateCodeAndCronjob(msg.sender, legacyAddress);

    // Emit layer2/3 created if needed
    uint256 distribution2 = ITransferEOALegacy(legacyAddress).getDistribution(2, layer2Distribution_.user);
    uint256 distribution3 = ITransferEOALegacy(legacyAddress).getDistribution(3, layer3Distribution_.user);

    if (distribution2 != 0) {
      emit TransferEOALegacyLayer23Created(newLegacyId, 2, layer2Distribution_, nickName2);
    }

    if (distribution3 != 0) {
      emit TransferEOALegacyLayer23Created(newLegacyId, 3, layer3Distribution_, nickName3);
    }

    return legacyAddress;
  }

  function avtiveAlive(uint256 legacyId_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    try 
    IPremiumSetting(premiumSetting).triggerOwnerResetReminder(legacyAddress) 
    {} catch {
      emit EmailOwnerResetNotCompleted(legacyAddress);
    }
    ITransferEOALegacy(legacyAddress).activeAlive(msg.sender);
    emit TransferEOALegacyActivedAlive(legacyId_, block.timestamp);
  }

  function setLegacyConfig(
    uint256 legacyId_,
    LegacyMainConfig calldata mainConfig_,
    TransferLegacyStruct.LegacyExtraConfig calldata extraConfig_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_,
    string calldata nickName2,
    string calldata nickName3
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    bool isPremium = IPremiumSetting(premiumSetting).isPremium(msg.sender);

    if (mainConfig_.distributions.length != mainConfig_.nickNames.length || mainConfig_.distributions.length == 0) revert DistributionsInvalid();
    if (extraConfig_.lackOfOutgoingTxRange == 0) revert ActivationTriggerInvalid();

    uint256 numberBeneficiaries = ITransferEOALegacy(legacyAddress).setLegacyDistributions(
      msg.sender,
      mainConfig_.distributions,
      mainConfig_.nickNames
    );
    if (!_checkNumBeneficiariesLimit(numberBeneficiaries)) revert NumBeneficiariesInvalid();

    // Set activation trigger
    ITransferEOALegacy(legacyAddress).setActivationTrigger(msg.sender, extraConfig_.lackOfOutgoingTxRange);

    // Set delay and layer 2/3 distribution - Now works for both premium and non-premium
    ITransferEOALegacy(legacyAddress).setDelayAndLayer23Distributions(
      msg.sender,
      extraConfig_.delayLayer2,
      extraConfig_.delayLayer3,
      nickName2,
      nickName3,
      layer2Distribution_,
      layer3Distribution_
    );

    // If the user is not premium, we don't emit events for layer 2/3 distributions
    if (isPremium) {
      // Only emit events for premium users (who can actually update layer 2/3)
      emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, 2, nickName2, layer2Distribution_, block.timestamp);

      emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, 3, nickName3, layer3Distribution_, block.timestamp);
    }

    ITransferEOALegacy(legacyAddress).setLegacyName(mainConfig_.name, msg.sender);

    // Emit final config update
    TransferLegacyStruct.LegacyExtraConfig memory _legacyExtraConfig = TransferLegacyStruct.LegacyExtraConfig({
      lackOfOutgoingTxRange: extraConfig_.lackOfOutgoingTxRange,
      delayLayer2: ITransferEOALegacy(legacyAddress).delayLayer2(),
      delayLayer3: ITransferEOALegacy(legacyAddress).delayLayer3()
    });

    emit TransferEOALegacyConfigUpdated(legacyId_, mainConfig_, _legacyExtraConfig, block.timestamp);
  }

  function setLegacyDistributions(
    uint256 legacyId_,
    string[] calldata nickNames_,
    TransferLegacyStruct.Distribution[] calldata distributions_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (distributions_.length != nickNames_.length || distributions_.length == 0) revert DistributionsInvalid();
    uint256 numberOfBeneficiaries = ITransferEOALegacy(legacyAddress).setLegacyDistributions(msg.sender, distributions_, nickNames_);
    if (!_checkNumBeneficiariesLimit(numberOfBeneficiaries)) revert NumBeneficiariesInvalid();

    emit TransferEOALegacyDistributionUpdated(legacyId_, nickNames_, distributions_, block.timestamp);
  }

  function setLayer23Distributions(
    uint256 legacyId_,
    uint8 layer_,
    string calldata nickname_,
    TransferLegacyStruct.Distribution calldata distribution_
  ) external {
    _setLayer23Distributions(legacyId_, layer_, nickname_, distribution_);
  }


    function setBothLayer23Distributions(
    uint256 legacyId_,
    string calldata nicknameLayer2_,
    TransferLegacyStruct.Distribution calldata layer2Distribution_,
    string calldata nicknameLayer3_,
    TransferLegacyStruct.Distribution calldata layer3Distribution_

  ) external {
    _setLayer23Distributions(legacyId_, 2, nicknameLayer2_, layer2Distribution_);
    _setLayer23Distributions(legacyId_, 3, nicknameLayer3_, layer3Distribution_);
  }

  function setActivationTrigger(uint256 legacyId_, uint128 lackOfOutgoingTxRange_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (lackOfOutgoingTxRange_ == 0) revert ActivationTriggerInvalid();
    ITransferEOALegacy(legacyAddress).setActivationTrigger(msg.sender, lackOfOutgoingTxRange_);
    emit TransferEOALegacyTriggerUpdated(legacyId_, lackOfOutgoingTxRange_, block.timestamp);
  }

  function setNameNote(uint256 legacyId_, string calldata name_, string calldata note_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).setLegacyName(name_, msg.sender);
    emit TransferEOALegacyNameNoteUpdated(legacyId_, name_, note_, block.timestamp);
  }

  function activeLegacy(uint256 legacyId_, address[] calldata assets_, bool isETH_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    if (isETH_ == false && assets_.length == 0) revert NumAssetsInvalid();

    //Active legacy
    ITransferEOALegacy(legacyAddress).activeLegacy(assets_, isETH_, msg.sender);
    uint8 beneLayer = ITransferEOALegacy(legacyAddress).getBeneficiaryLayer(msg.sender);
    uint8 currentLayer = ITransferEOALegacy(legacyAddress).getLayer();
    if (beneLayer > currentLayer) revert CannotClaim();
    if (beneLayer == 0) revert OnlyBeneficaries();

    // Activation is a one-way state change: the legacy's `_isActive` flips
    // to 2 inside the call above and the contract becomes a tombstone
    // (`deleteLegacy` is blocked from here on). Release the owner's
    // create-flag so they can spin up a new legacy without coordinating
    // with us. Idempotent — repeat calls (multi-tranche claims that
    // re-enter activeLegacy) are no-ops. We read the owner via
    // IPremiumLegacy because GenericLegacy's `getLegacyOwner` is non-virtual
    // and ITransferEOALegacy can't redeclare it without an override clash.
    isCreateLegacy[IPremiumLegacy(legacyAddress).getLegacyOwner()] = false;

    emit TransferEOALegacyActivated(legacyId_, beneLayer, block.timestamp);
  }

  /**
   * @dev Beneficiary claims the legacy; if the owner has an active storage-token swap,
   * it is atomically swapped back to ETH and distributed in the same transaction.
   */
  function activeLegacyAndUnswap(
    uint256 legacyId_,
    address[] calldata assets_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);

    ITransferEOALegacy(legacyAddress).activeLegacyAndUnswap(
      assets_,
      msg.sender,
      amountOutMin_,
      deadline_
    );

    uint8 beneLayer = ITransferEOALegacy(legacyAddress).getBeneficiaryLayer(msg.sender);
    uint8 currentLayer = ITransferEOALegacy(legacyAddress).getLayer();
    if (beneLayer > currentLayer) revert CannotClaim();
    if (beneLayer == 0) revert OnlyBeneficaries();

    // Same one-way-state-change reasoning as activeLegacy — release the
    // owner so they aren't permanently locked out of creating a fresh one.
    isCreateLegacy[IPremiumLegacy(legacyAddress).getLegacyOwner()] = false;

    emit TransferEOALegacyActivatedWithUnswap(legacyId_, beneLayer, block.timestamp);
  }

  function deleteLegacy(uint256 legacyId_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    isCreateLegacy[msg.sender] = false;

    ITransferEOALegacy(legacyAddress).deleteLegacy(msg.sender);
    emit TransferEOALegacyDeleted(legacyId_, block.timestamp);
  }

  /**
   * @dev Self-service flag-release for owners of already-tombstoned legacies.
   *
   * `deleteLegacy` reverts on legacies that have already been activated
   * (the underlying contract's `isActiveLegacy` modifier blocks delete after
   * `_isActive == 2`), which historically left their owners with a stuck
   * `isCreateLegacy[sender] = true` and no path back. This entry point lets
   * the owner clear that flag for any of their legacies that the system
   * itself considers no-longer-live (claimed by a beneficiary, or deleted
   * via `deleteLegacy`).
   *
   * Authorization: caller must be the legacy's recorded owner. The
   * `isLive()` check on the child contract returns false for both the
   * `_isActive == 2` (claimed) and `_isLive == 2` (deleted) terminal
   * states, so this covers every case where `isCreateLegacy[owner]` could
   * have been left dangling.
   *
   * Idempotent and chain-safe: re-entering on a fresh legacy reverts
   * `LegacyStillActive`; re-entering on the same dead legacy is a no-op
   * write that keeps the flag false.
   */
  function releaseCreateFlag(uint256 legacyId_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    if (legacy.getLegacyOwner() != msg.sender) revert OnlyOwner();
    if (legacy.isLive()) revert LegacyStillActive();
    isCreateLegacy[msg.sender] = false;
    emit TransferEOALegacyCreateFlagReleased(legacyId_, msg.sender, block.timestamp);
  }

  function withdraw(uint256 legacyId_, uint256 amount_) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).withdraw(msg.sender, amount_);
  }

  /**
   * @dev Forwards ETH + swap config to the individual legacy contract.
   * The individual contract swaps ETH -> storageToken and sends tokens to the owner's wallet.
   */
  function autoSwap(
    uint256 legacyId_,
    TransferLegacyStruct.EOALegacyETHSwap calldata swap_
  ) external payable {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).autoSwap{value: msg.value}(msg.sender, swap_);
    emit TransferEOALegacyAutoSwapped(legacyId_, swap_.storageToken, msg.value, block.timestamp);
  }

  /**
   * @dev Forwards unswap request to the individual legacy contract.
   * Pulls storageToken from owner's wallet, swaps to ETH, sends ETH to owner.
   */
  function unswap(
    uint256 legacyId_,
    uint256 amountIn_,
    uint256 amountOutMin_,
    uint256 deadline_
  ) external {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    address storageToken = ITransferEOALegacy(legacyAddress).eoaStorageToken();
    ITransferEOALegacy(legacyAddress).unswap(msg.sender, amountIn_, amountOutMin_, deadline_);
    emit TransferEOALegacyUnswapped(legacyId_, storageToken, amountIn_, block.timestamp);
  }

  /**
   * @dev Returns the expected token amount out for a given ETH amount via Uniswap V2.
   */
  function getEthToTokenAmountOut(
    uint256 ethAmount_,
    address outputToken_
  ) external view returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = weth;
    path[1] = outputToken_;
    uint256[] memory amounts = IUniswapV2Router02(uniswapRouter).getAmountsOut(ethAmount_, path);
    return amounts[1];
  }

  /**
   * @dev Returns the expected ETH amount out for a given token amount via Uniswap V2.
   */
  function getTokenToEthAmountOut(
    uint256 tokenAmount_,
    address token_
  ) external view returns (uint256) {
    address[] memory path = new address[](2);
    path[0] = token_;
    path[1] = weth;
    uint256[] memory amounts = IUniswapV2Router02(uniswapRouter).getAmountsOut(tokenAmount_, path);
    return amounts[1];
  }

  function _setLayer23Distributions(
    uint256 legacyId_,
    uint8 layer_,
    string calldata nickname_,
    TransferLegacyStruct.Distribution calldata distribution_
  ) internal {
    address legacyAddress = _checkLegacyExisted(legacyId_);
    ITransferEOALegacy(legacyAddress).setLayer23Distributions(msg.sender, layer_, nickname_, distribution_);
    emit TransferEOALegacyLayer23DistributionUpdated(legacyId_, layer_, nickname_, distribution_, block.timestamp);
  }
}
