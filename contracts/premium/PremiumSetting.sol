// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../interfaces/ISafeWallet.sol";
import "../interfaces/IPremiumLegacy.sol";
import "../interfaces/IPremiumSetting.sol";

import {TransferLegacyStruct} from "../libraries/TransferLegacyStruct.sol";

contract PremiumSetting is OwnableUpgradeable, IPremiumSetting {
  struct UserConfig {
    string ownerName;
    string ownerEmail;
    uint256 timePriorActivation;
  }
  struct EmailMapping {
    address addr;
    string email;
    string name;
  }
  struct LegacyConfig {
    EmailMapping[] cosigners;
    EmailMapping[] beneficiaries;
    EmailMapping secondLine;
    EmailMapping thirdLine;
  }

  /// @dev Phase B PII-free input: the reminder recipient *set* is addresses only.
  /// Emails/names live off-chain in the reminder-worker (posted via its EIP-712 /ingest).
  /// The legacy `EmailMapping`-based storage above is kept for upgrade-storage-layout
  /// stability and is written with empty email/name strings from this input.
  struct LegacyRecipients {
    address[] cosigners;
    address[] beneficiaries;
    address secondLine; // address(0) = unset
    address thirdLine; // address(0) = unset
  }

  mapping(address => uint) public premiumExpired; // timestamp that premium package ends
  mapping(address => UserConfig) public userConfigs;
  mapping(address => LegacyConfig) public legacyCfgs;
  mapping(uint256 => address) private legacyCodeToAddress;
  mapping(address => uint256) private legacyAddressToCode;

  address public premiumRegistry; // contract serves for register premium package  & payment
  address public transferLegacyContractRouter;
  address public transferLegacyEOAContractRouter;
  address public multisigLegacyContractRouter;

  // Chainlink-era automation/mail wiring — RETIRED (Phase B). Kept as deprecated
  // storage placeholders to preserve the upgradeable proxy layout; never read/written.
  address private __deprecatedPremiumAutomationManager;
  address private __deprecatedPremiumSendMail;

  mapping(address => address[]) private __deprecatedLegacyQueuedToAddCronjob;

  /* Event */
  event PremiumTimeUpdated(address indexed user, uint256 newExpiredTime);
  event PremiumReset(address indexed user);
  /// @dev Phase B: PII-free. Email/name are no longer stored on-chain; `timePriorActivation`
  /// is the only configurable field. The reminder-worker holds emails off-chain.
  event UserConfigUpdated(address indexed user, uint256 timePriorActivation);
  /// @dev Phase B: PII-free recipient set (addresses only). The subgraph indexes these to
  /// know *who* is configured; the worker joins them to its off-chain encrypted emails.
  event LegacyReminderUpdated(
    address indexed user,
    uint256 legacyId,
    address legacyAddress,
    uint128 legacyType,
    address[] cosigners,
    address[] beneficiaries,
    address secondLine,
    address thirdLine
  );

  event BeneficiariesEmailSync(address indexed user, uint256 legacyId, address legacyAddress, uint128 legacyType, address[] beneficiaries);
  /// @dev Emitted when a user/creator wipes any pre-Phase-B name/email strings from storage.
  event PIICleared(address indexed user, address legacyAddress);
  event SecondLineEmailReset(address indexed user, uint256 legacyId, address legacyAddress, uint128 legacyType);
  event ThirdLineEmailReset(address indexed user, uint256 legacyId, address legacyAddress, uint128 legacyType);
  event LegacyConfigReset(address indexed user, uint256 legacyId, address legacyAddress, uint128 legacyType);
  event WatcherUpdated(
    address indexed user,
    uint256 legacyId,
    address legacyAddress,
    uint legacyType,
    string[] name,
    address[] watchers,
    bool[] isFullVisibility
  );
  event WatcherReset(address indexed user, uint256 legacyId, address legacyAddress, uint legacyType);
  event LegacyPrivateCodeSet(uint256 legacyId, address legacyAddress, uint128 legacyType, uint256 code);

  /// @dev Phase B / Option B: PII-free notify signal for the off-chain reminder-worker.
  /// Carries addresses + enums ONLY — never names/emails. Recipient *addresses* are NOT
  /// carried here: they are already indexed from the config events (LegacyReminderUpdated /
  /// BeneficiariesEmailSync), so the worker joins this trigger signal to the recipient set
  /// it already holds and resolves emails from its off-chain encrypted store keyed by
  /// (chainId, legacy, recipient). Omitting recipients[] also keeps the implementation under
  /// the 24576-byte mainnet limit during the emit-alongside window (no on-chain array build).
  /// `layer` is the activated layer (ActivatedTransfer) or the legacy's layer otherwise; the
  /// worker uses it to pick which configured recipients to notify. chainId is intentionally
  /// NOT carried: the subgraph + worker are per-network, so the chain is implicit (and
  /// omitting it keeps the impl under the 24576-byte mainnet limit in the emit-alongside window).
  /// Emitted ALONGSIDE the legacy `premiumSendMail` path (Deploy 1, non-breaking) and BEFORE
  /// the `premiumSendMail` wiring is consulted, so the new path is independent of the
  /// Chainlink-era mail contracts (which go inert at cutover, Deploy 2).
  enum NotifyType {
    OwnerReset,
    ActivatedMultisig,
    ActivatedTransfer
  }
  event LegacyEmailNotifyRequested(
    address indexed legacy,
    address indexed creator,
    uint8 layer,
    uint8 notifyType
  );

  error LengthMismatch();
  error UserConfigNotSet();
  error InvalidParamAddress();
  error PremiumOnly();
  error RouterOnly();
  error TimePriorZero();
  error OnlyLegacyCreator();
  error NotPremiumUser();
  error RegistryOnly();
  error AlreadyPremium();
  error InvalidLayer();
  error CannotSetEmpty();
  error OnlySafeCosigners();
  error InvalidCosigner();
  error BeneficiaryMismatch();
  error InvalidBeneficiary();
  error InvalidLineAddress();
  error TooManyAttempts();

  /* Modifier */
  modifier onlyPremium(address user) {
    if (!isPremium(user)) revert PremiumOnly();
    _;
  }

  modifier onlyRouter() {
    if (
      msg.sender != transferLegacyContractRouter &&
      msg.sender != transferLegacyEOAContractRouter &&
      msg.sender != multisigLegacyContractRouter &&
      msg.sender != owner()
    ) revert RouterOnly();
    _;
  }

  modifier requireUserConfig(address user) {
    if(userConfigs[user].timePriorActivation == 0) revert UserConfigNotSet();
    _;
  }

  constructor () {
    _disableInitializers();
  }

  function initialize() public initializer {
    __Ownable_init(msg.sender);
  }

  function setParams(
    address _premiumRegistry,
    address _transferLegacyContractRouter,
    address _transferLegacyEOAContractRouter,
    address _multisigLegacyContractRouter
  ) external onlyOwner {
    if (_premiumRegistry == address(0)) revert InvalidParamAddress();
    // _transferLegacyContractRouter is allowed to be address(0) since the
    // Safe-source Transfer flow was sunset (v2026.05.18). The storage slot
    // is preserved for upgradeability — see comment in LegacyDeployer.sol.
    if(_transferLegacyEOAContractRouter == address(0)) revert InvalidParamAddress();
    if(_multisigLegacyContractRouter == address(0)) revert InvalidParamAddress();

    premiumRegistry = _premiumRegistry;
    transferLegacyContractRouter = _transferLegacyContractRouter;
    transferLegacyEOAContractRouter = _transferLegacyEOAContractRouter;
    multisigLegacyContractRouter = _multisigLegacyContractRouter;
  }

  /* USER FUNCTIONS */
  ///@notice user sets up reminder timing + recipient *addresses*. Emails/names are PII and
  /// are no longer stored on-chain — the frontend posts them to the reminder-worker /ingest.
  ///@param timePriorActivation The time (in seconds) before the scheduled activation when email reminders should be sent.
  function setReminderConfigs(
    uint256 timePriorActivation,
    address[] calldata legacyAddresses,
    LegacyRecipients[] calldata legacyData
  ) external onlyPremium(msg.sender) {
    if (legacyAddresses.length != legacyData.length) revert LengthMismatch();
    if (timePriorActivation == 0) revert TimePriorZero();

    //update user config (timing only)
    _updateUserConfig(msg.sender, timePriorActivation);

    //update legacy recipient sets
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      _updateLegacyConfig(legacyAddresses[i], legacyData[i]);
    }
  }

  ///@notice update reminder timing only.
  ///@param timePriorActivation The time (in seconds) before the scheduled activation when email reminders should be sent.
  function updateUserConfig(uint256 timePriorActivation) external onlyPremium(msg.sender) {
    _updateUserConfig(msg.sender, timePriorActivation);
  }

  function updateLegacyConfig(address[] calldata legacyAddresses, LegacyRecipients[] calldata legacyData) external onlyPremium(msg.sender) {
    if (legacyAddresses.length != legacyData.length) revert LengthMismatch();
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      _updateLegacyConfig(legacyAddresses[i], legacyData[i]);
    }
  }

  function clearLegacyConfig(address[] calldata legacyAddresses) external onlyPremium(msg.sender) {
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddresses[i]);
      if (msg.sender != transferLegacy.creator()) revert OnlyLegacyCreator();
      _clearLegacyConfig(legacyAddresses[i]);
      emit LegacyConfigReset(msg.sender, transferLegacy.getLegacyId(), legacyAddresses[i], transferLegacy.LEGACY_TYPE());
    }
  }

  /// @notice Phase B hygiene: wipe any name/email strings stored under the caller's user
  /// config in the pre-Phase-B era. `timePriorActivation` is preserved. Not premium-gated so
  /// a lapsed user can still erase their own residual PII.
  function clearUserPII() external {
    UserConfig storage uc = userConfigs[msg.sender];
    uc.ownerName = "";
    uc.ownerEmail = "";
    emit PIICleared(msg.sender, address(0));
  }

  /// @notice Phase B hygiene: wipe name/email strings from a legacy's stored recipient set
  /// while keeping the (non-PII) addresses. Callable by the legacy creator.
  function clearLegacyPII(address[] calldata legacyAddresses) external {
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      if (msg.sender != IPremiumLegacy(legacyAddresses[i]).creator()) revert OnlyLegacyCreator();
      LegacyConfig storage cfg = legacyCfgs[legacyAddresses[i]];
      for (uint256 j = 0; j < cfg.cosigners.length; j++) {
        cfg.cosigners[j].email = "";
        cfg.cosigners[j].name = "";
      }
      for (uint256 j = 0; j < cfg.beneficiaries.length; j++) {
        cfg.beneficiaries[j].email = "";
        cfg.beneficiaries[j].name = "";
      }
      cfg.secondLine.email = "";
      cfg.secondLine.name = "";
      cfg.thirdLine.email = "";
      cfg.thirdLine.name = "";
      emit PIICleared(msg.sender, legacyAddresses[i]);
    }
  }

  /// @dev set premiumExpired of an adress to 0
  function resetPremium(address user) external onlyOwner {
    if (premiumExpired[user] == 0) revert NotPremiumUser();
    premiumExpired[user] = 0;
    emit PremiumReset(user);
  }

  /// @dev called by the PremiumRegistry contract to update a user's premium expiration time.
  /// @param duration amount of time (in seconds) of the premium package plan
  function updatePremiumTime(address user, uint256 duration) external {
    if (msg.sender != premiumRegistry) revert RegistryOnly();
    if (premiumExpired[user] > block.timestamp) revert AlreadyPremium();
    if (duration >= type(uint256).max - block.timestamp) {
      premiumExpired[user] = type(uint256).max;
    } else {
      premiumExpired[user] = block.timestamp + duration;
    }

    emit PremiumTimeUpdated(user, premiumExpired[user]);
  }

  /* LEGACY ROUTER FUNCTIONS*/
  ///@dev router call this function when update legacy to remove email that not belong to any beneficiaries
  function syncBeneficiariesEmails(
    address user,
    address legacyAddress,
    TransferLegacyStruct.Distribution[] calldata newDistributions_
  ) external onlyRouter {
    EmailMapping[] storage beneficiaries = legacyCfgs[legacyAddress].beneficiaries;
    //remove old emails
    for (uint256 i = 0; i < beneficiaries.length; i++) {
      if (!_contains(newDistributions_, beneficiaries[i].addr)) {
        uint lastIndex = beneficiaries.length - 1;
        if (i != lastIndex) {
          beneficiaries[i] = beneficiaries[lastIndex]; // swap
        }
        beneficiaries.pop();
      }
    }

    address[] memory beneAddrs = new address[](beneficiaries.length);
    for (uint256 i = 0; i < beneficiaries.length; i++) {
      beneAddrs[i] = beneficiaries[i].addr;
    }

    IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddress);
    emit BeneficiariesEmailSync(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE(), beneAddrs);
  }

  function resetLayerEmail(address user, address legacyAddress, uint8 layer) external onlyRouter {
    IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddress);
    if (layer != 2 && layer != 3) revert InvalidLayer();
    if (layer == 2) {
      delete legacyCfgs[legacyAddress].secondLine;
      emit SecondLineEmailReset(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE());
    } else {
      delete legacyCfgs[legacyAddress].thirdLine;
      emit ThirdLineEmailReset(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE());
    }
  }

  /// @dev Phase B end-state: the cronjob queue is retired (Chainlink Automation gone).
  /// Kept name + signature so the legacy routers' ABI is unchanged; now only assigns the
  /// legacy's private code. `user` is unused (retained for the router-facing signature).
  function setPrivateCodeAndCronjob(address, address legacyAddress) external onlyRouter {
    _setPrivateCodeIfNeeded(legacyAddress);
  }

  /// @dev Phase B end-state: emit-only. The off-chain worker drives the actual email from
  /// LegacyEmailNotifyRequested (PII looked up in its own encrypted store). The legacy-router
  /// owner-reset flow (avtiveAlive) calls this via onlyRouter.
  function triggerOwnerResetReminder(address legacyAddress) external onlyRouter {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    address creator = legacy.creator();
    if (!isPremium(creator)) return;
    emit LegacyEmailNotifyRequested(legacyAddress, creator, legacy.getLayer(), uint8(NotifyType.OwnerReset));
  }

  /// @dev Phase B end-state: emit-only (see triggerOwnerResetReminder). Multisig router calls
  /// this on activation; the worker sends owner + beneficiary emails off-chain.
  function triggerActivationMultisig(address legacyAddress) external onlyRouter {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    address creator = legacy.creator();
    if (!isPremium(creator)) return;
    emit LegacyEmailNotifyRequested(legacyAddress, creator, legacy.getLayer(), uint8(NotifyType.ActivatedMultisig));
  }

  /// @dev Phase B end-state: replaces the deleted `triggerActivationTransferLegacy`
  /// (+ its spoofable `onlyLegacy` modifier — M-2′). Called by the EOA router during
  /// activation (`onlyRouter`, non-spoofable) to emit the PII-free transfer-activation
  /// notify. Per-beneficiary asset amounts are no longer passed inline — the off-chain
  /// worker reconstructs them from the activation tx's ERC-20/ETH Transfer events.
  function notifyActivatedTransfer(address legacyAddress, address activatingBene) external onlyRouter {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    address creator = legacy.creator();
    if (!isPremium(creator)) return;
    uint8 layerActivated = legacy.getBeneficiaryLayer(activatingBene);
    emit LegacyEmailNotifyRequested(legacyAddress, creator, layerActivated, uint8(NotifyType.ActivatedTransfer));
  }

  function setWatchers(
    address legacyAddress,
    string[] calldata names,
    address[] calldata watchers,
    bool[] calldata isFullVisibility
  ) external onlyPremium(msg.sender) {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    (uint256 legacyId, , ) = legacy.getLegacyInfo();
    uint128 legacyType = legacy.LEGACY_TYPE();
    if (msg.sender != legacy.creator()) revert OnlyLegacyCreator();
    if (names.length != watchers.length || watchers.length != isFullVisibility.length) revert LengthMismatch();
    if (names.length == 0) revert CannotSetEmpty();
    emit WatcherUpdated(msg.sender, legacyId, legacyAddress, legacyType, names, watchers, isFullVisibility);
  }

  function clearWatcher(address[] memory legacyAddresses) external onlyPremium(msg.sender) {
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      IPremiumLegacy legacy = IPremiumLegacy(legacyAddresses[i]);
      (uint256 legacyId, , ) = legacy.getLegacyInfo();
      uint128 legacyType = legacy.LEGACY_TYPE();
      if (msg.sender != legacy.creator()) revert OnlyLegacyCreator();
      emit WatcherReset(msg.sender, legacyId, legacyAddresses[i], legacyType);
    }
  }

  /* INTERNAL FUNCTIONS */
  function _updateUserConfig(address user, uint256 timePriorActivation) internal {
    if (timePriorActivation == 0) revert TimePriorZero();
    UserConfig storage uc = userConfigs[user];
    // Wipe any pre-Phase-B PII left in storage and keep timing only.
    uc.ownerName = "";
    uc.ownerEmail = "";
    uc.timePriorActivation = timePriorActivation;
    emit UserConfigUpdated(user, timePriorActivation);
  }

  function _updateLegacyConfig(address legacyAddr, LegacyRecipients calldata newCfg) internal requireUserConfig(msg.sender) {
    //prepare data
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddr);
    (uint256 legacyId, address owner, ) = legacy.getLegacyInfo();
    uint128 legacyType = legacy.LEGACY_TYPE();

    if (msg.sender != legacy.creator()) revert OnlyLegacyCreator();
    _clearLegacyConfig(legacyAddr);

    // Set cosigners (safe legacy) -> check cosigner valid. Stored PII-free (addr only).
    LegacyConfig storage cfg = legacyCfgs[legacyAddr];
    if (newCfg.cosigners.length > 0) {
      if (legacyType == 3) revert OnlySafeCosigners();
      ISafeWallet safe = ISafeWallet(owner);
      if (newCfg.cosigners.length != safe.getOwners().length) revert LengthMismatch();
      for (uint256 j = 0; j < newCfg.cosigners.length; j++) {
        address cosigner = newCfg.cosigners[j];
        if (!safe.isOwner(cosigner)) revert InvalidCosigner();
        cfg.cosigners.push(EmailMapping({addr: cosigner, email: "", name: ""}));
      }
    }

    // Set beneficiaries - validate address in legacy by checking distribution
    if (legacyType == 1) {
      address[] memory beneficiaries = legacy.getBeneficiaries();
      for (uint256 j = 0; j < newCfg.beneficiaries.length; j++) {
        if (newCfg.beneficiaries[j] != beneficiaries[j]) revert BeneficiaryMismatch();
        cfg.beneficiaries.push(EmailMapping({addr: newCfg.beneficiaries[j], email: "", name: ""}));
      }
    } else {
      for (uint256 j = 0; j < newCfg.beneficiaries.length; j++) {
        address beneficiary = newCfg.beneficiaries[j];
        if (legacy.getDistribution(1, beneficiary) == 0) revert InvalidBeneficiary();
        cfg.beneficiaries.push(EmailMapping({addr: beneficiary, email: "", name: ""}));
      }
    }

    // Set second and third line - validate address in legacy by checking distribution
    if (newCfg.secondLine != address(0)) {
      if (legacy.getDistribution(2, newCfg.secondLine) == 0) revert InvalidLineAddress();
      cfg.secondLine = EmailMapping({addr: newCfg.secondLine, email: "", name: ""});
    }
    if (newCfg.thirdLine != address(0)) {
      if (legacy.getDistribution(3, newCfg.thirdLine) == 0) revert InvalidLineAddress();
      cfg.thirdLine = EmailMapping({addr: newCfg.thirdLine, email: "", name: ""});
    }

    emit LegacyReminderUpdated(
      msg.sender,
      legacyId,
      legacyAddr,
      legacyType,
      newCfg.cosigners,
      newCfg.beneficiaries,
      newCfg.secondLine,
      newCfg.thirdLine
    );
  }

  function _clearLegacyConfig(address legacyAddress) internal {
    delete legacyCfgs[legacyAddress];
  }

  ///@notice set private code for legacy of premium user
  function _setPrivateCodeIfNeeded(address legacyAddress) internal {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    if (legacyAddressToCode[legacyAddress] != 0) return; //already set
    uint256 attempt = 0;
    uint256 code;

    do {
      code = (uint256(keccak256(abi.encodePacked(legacyAddress, block.timestamp, attempt))) % 9_000_000) + 1_000_000;
      attempt++;
      if (attempt >= 20) revert TooManyAttempts();
    } while (legacyCodeToAddress[code] != address(0)); //avoid duplicate

    legacyAddressToCode[legacyAddress] = code;
    legacyCodeToAddress[code] = legacyAddress;
    emit LegacyPrivateCodeSet(legacy.getLegacyId(), legacyAddress, legacy.LEGACY_TYPE(), code);
  }

  ///@dev to check if a beneficiary of legacy has an email configured
  function _contains(TransferLegacyStruct.Distribution[] calldata list, address addr) internal pure returns (bool) {
    for (uint i = 0; i < list.length; i++) {
      if (list[i].user == addr) return true;
    }
    return false;
  }

  function isSafeLegacy(address legacyAddress) public view returns (bool) {
    address legacyOwner = IPremiumLegacy(legacyAddress).getLegacyOwner();
    return legacyOwner.code.length > 0;
  }

  /*  VIEWS FUNCTIONS */
  function isPremium(address user) public view returns (bool) {
    return (block.timestamp < premiumExpired[user]);
  }

  function getUserData(address user) public view returns (string memory, string memory, uint256) {
    return (userConfigs[user].ownerName, userConfigs[user].ownerEmail, userConfigs[user].timePriorActivation);
  }

  function getCosignerData(address legacyAddress) external view returns (address[] memory, string[] memory, string[] memory) {
    EmailMapping[] storage list = legacyCfgs[legacyAddress].cosigners;

    uint256 len = list.length;
    address[] memory addrs = new address[](len);
    string[] memory emails = new string[](len);
    string[] memory names = new string[](len);

    for (uint256 i = 0; i < len; i++) {
      addrs[i] = list[i].addr;
      emails[i] = list[i].email;
      names[i] = list[i].name;
    }

    return (addrs, emails, names);
  }

  function getBeneficiaryData(address legacyAddress) public view returns (address[] memory, string[] memory, string[] memory) {
    EmailMapping[] storage list = legacyCfgs[legacyAddress].beneficiaries;

    uint256 len = list.length;
    address[] memory addrs = new address[](len);
    string[] memory emails = new string[](len);
    string[] memory names = new string[](len);

    for (uint256 i = 0; i < len; i++) {
      addrs[i] = list[i].addr;
      emails[i] = list[i].email;
      names[i] = list[i].name;
    }

    return (addrs, emails, names);
  }

  function getSecondLineData(address legacyAddress) public view returns (address, string memory, string memory) {
    EmailMapping storage second = legacyCfgs[legacyAddress].secondLine;
    return (second.addr, second.email, second.name);
  }

  function getThirdLineData(address legacyAddress) public view returns (address, string memory, string memory) {
    EmailMapping storage third = legacyCfgs[legacyAddress].thirdLine;
    return (third.addr, third.email, third.name);
  }

  function getTimeAhead(address user) public view returns (uint256) {
    return userConfigs[user].timePriorActivation;
  }

  function getLegacyCode(address legacyAddress) external view onlyOwner returns (uint256) {
    return legacyAddressToCode[legacyAddress];
  }

  ///@dev FE use to fetch all legacy trigger timestamp
  function getBatchLegacyTriggerTimestamp(address[] memory legacyAddresses) external view returns (uint256[][] memory) {
    uint256[][] memory result = new uint256[][](legacyAddresses.length);
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      (uint256 t1, uint256 t2, uint256 t3) = IPremiumLegacy(legacyAddresses[i]).getTriggerActivationTimestamp();

      uint256[] memory timestamps = new uint256[](3);
      timestamps[0] = t1;
      timestamps[1] = t2;
      timestamps[2] = t3;

      result[i] = timestamps;
    }
    return result;
  }
}
