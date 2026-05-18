// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "../interfaces/ISafeWallet.sol";
import "../interfaces/IPremiumLegacy.sol";
import "../interfaces/IPremiumAutomationManager.sol";
import "../interfaces/IPremiumSendMail.sol";
import "../interfaces/IPremiumSetting.sol";
import "../libraries/ArrayUtils.sol";

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

  mapping(address => uint) public premiumExpired; // timestamp that premium package ends
  mapping(address => UserConfig) public userConfigs;
  mapping(address => LegacyConfig) public legacyCfgs;
  mapping(uint256 => address) private legacyCodeToAddress;
  mapping(address => uint256) private legacyAddressToCode;

  address public premiumRegistry; // contract serves for register premium package  & payment
  address public transferLegacyContractRouter;
  address public transferLegacyEOAContractRouter;
  address public multisigLegacyContractRouter;

  IPremiumAutomationManager public premiumAutomationManager;
  IPremiumSendMail public premiumSendMail;

  mapping(address => address[]) private legacyQueuedToAddCronjob; // legacy that user created when not subcribe premium

  /* Event */
  event PremiumTimeUpdated(address indexed user, uint256 newExpiredTime);
  event PremiumReset(address indexed user);
  event UserConfigUpdated(address indexed user, string name, string email, uint256 timePriorActivation);
  event LegacyReminderUpdated(
    address indexed user,
    uint256 legacyId,
    address legacyAddress,
    uint128 legacyType,
    EmailMapping[] cosigners,
    EmailMapping[] beneficiaries,
    EmailMapping secondLine,
    EmailMapping thirdLine
  );

  event BeneficiariesEmailSync(address indexed user, uint256 legacyId, address legacyAddress, uint128 legacyType, EmailMapping[] beneficiaries);
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

  error LengthMismatch();
  error UserConfigNotSet();
  error InvalidParamAddress();

  /* Modifier */
  modifier onlyPremium(address user) {
    require(isPremium(user), "Premium only");
    _;
  }

  modifier onlyRouter() {
    require(
      msg.sender == transferLegacyContractRouter ||
        msg.sender == transferLegacyEOAContractRouter ||
        msg.sender == multisigLegacyContractRouter ||
        msg.sender == owner(),
      "Router only"
    );
    _;
  }

  modifier onlyLegacy() {
    address router = IPremiumLegacy(msg.sender).router();
    if (msg.sender != owner()) {
      require(
        router == transferLegacyContractRouter || router == transferLegacyEOAContractRouter || router == multisigLegacyContractRouter,
        "Only Legacy"
      );
    }
    _;
  }

  modifier requireUserConfig(address user) {
    if(bytes(userConfigs[user].ownerName).length == 0) revert UserConfigNotSet();
    if(userConfigs[user].timePriorActivation== 0) revert UserConfigNotSet();
    if(bytes(userConfigs[user].ownerEmail).length == 0) revert UserConfigNotSet();
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

  function setUpReminder(address _premiumAutomationManager, address _premiumSendMail) external onlyOwner {
    if(_premiumAutomationManager == address(0)) revert InvalidParamAddress();
    if(_premiumSendMail == address(0)) revert InvalidParamAddress();
    premiumAutomationManager = IPremiumAutomationManager(_premiumAutomationManager);
    premiumSendMail = IPremiumSendMail(_premiumSendMail);
  }

  /* USER FUNCTIONS */
  ///@notice user set up emails reminder / edit configs
  ///@param timePriorActivation The time (in seconds) before the scheduled activation when email reminders should be sent.
  function setReminderConfigs(
    string calldata name,
    string calldata ownerEmail,
    uint256 timePriorActivation,
    address[] calldata legacyAddresses,
    LegacyConfig[] calldata legacyData
  ) external onlyPremium(msg.sender) {
    require(legacyAddresses.length == legacyData.length, "Length mismatch");
    require(timePriorActivation > 0, "timePriorActivation > 0");

    //update user configs
    _updateUserConfig(msg.sender, name, ownerEmail, timePriorActivation);

    //update legacy configs
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      _updateLegacyConfig(legacyAddresses[i], legacyData[i]);
    }
  }

  ///@notice update email and timePriorActivation
  ///@param timePriorActivation The time (in seconds) before the scheduled activation when email reminders should be sent.
  function updateUserConfig(string calldata name, string calldata ownerEmail, uint256 timePriorActivation) external onlyPremium(msg.sender) {
    _updateUserConfig(msg.sender, name, ownerEmail, timePriorActivation);
  }

  function updateLegacyConfig(address[] calldata legacyAddresses, LegacyConfig[] calldata legacyData) external onlyPremium(msg.sender) {
    require(legacyAddresses.length == legacyData.length, "Length mismatch");
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      _updateLegacyConfig(legacyAddresses[i], legacyData[i]);
    }
  }

  function clearLegacyConfig(address[] calldata legacyAddresses) external onlyPremium(msg.sender) {
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddresses[i]);
      require(msg.sender == transferLegacy.creator(), "only legacy creator");
      _clearLegacyConfig(legacyAddresses[i]);
      emit LegacyConfigReset(msg.sender, transferLegacy.getLegacyId(), legacyAddresses[i], transferLegacy.LEGACY_TYPE());
    }
  }

  /// @dev set premiumExpired of an adress to 0
  function resetPremium(address user) external onlyOwner {
    require(premiumExpired[user] != 0, "Not an premium user");
    premiumExpired[user] = 0;
    emit PremiumReset(user);
  }

  /// @dev called by the PremiumRegistry contract to update a user's premium expiration time.
  /// @param duration amount of time (in seconds) of the premium package plan
  function updatePremiumTime(address user, uint256 duration) external {
    require(msg.sender == premiumRegistry, "_premiumRegistry only");
    require(premiumExpired[user] <= block.timestamp, "Already premium");
    if (duration >= type(uint256).max - block.timestamp) {
      premiumExpired[user] = type(uint256).max;
    } else {
      premiumExpired[user] = block.timestamp + duration;
    }

    emit PremiumTimeUpdated(user, premiumExpired[user]);

    //add queued legacy to cronjob
    if (address(premiumAutomationManager) != address(0)) {
      if (legacyQueuedToAddCronjob[user].length > 0) {
        premiumAutomationManager.addLegacyCronjob(user, legacyQueuedToAddCronjob[user]);
        delete legacyQueuedToAddCronjob[user];
      } 
    }
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

    IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddress);
    emit BeneficiariesEmailSync(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE(), beneficiaries);
  }

  function resetLayerEmail(address user, address legacyAddress, uint8 layer) external onlyRouter {
    IPremiumLegacy transferLegacy = IPremiumLegacy(legacyAddress);
    require(layer == 2 || layer == 3, "invalid layer");
    if (layer == 2) {
      delete legacyCfgs[legacyAddress].secondLine;
      emit SecondLineEmailReset(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE());
    } else {
      delete legacyCfgs[legacyAddress].thirdLine;
      emit ThirdLineEmailReset(user, transferLegacy.getLegacyId(), legacyAddress, transferLegacy.LEGACY_TYPE());
    }
  }

  function setPrivateCodeAndCronjob(address user, address legacyAddress) external onlyRouter {
    _setPrivateCodeIfNeeded(legacyAddress);
    address[] memory legacyAddresses = new address[](1);
    legacyAddresses[0] = legacyAddress;
    if (isPremium(user) && address(premiumAutomationManager) != address(0)) {
      premiumAutomationManager.addLegacyCronjob(user, legacyAddresses);
    } else {
      legacyQueuedToAddCronjob[user].push(legacyAddress);
    }
  }

  function triggerOwnerResetReminder(address legacyAddress) external onlyRouter {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);
    address creator = legacy.creator();
    if (!isPremium(creator)) return;
    if (address(premiumSendMail) == address(0)) return;

    //specify which layer need to send mail
    uint8 layer = IPremiumLegacy(legacy).getLayer();
    string memory contractName = legacy.getLegacyName();

    (, string[] memory beneEmails, string[] memory beneNames) = getBeneficiaryData(legacyAddress);
    premiumSendMail.sendMailOwnerResetToBene(beneNames, beneEmails, contractName);

    if (layer >= 2) {
      (, string memory layer2Email, string memory layer2Name) = getSecondLineData(legacyAddress);
      if (bytes(layer2Email).length > 0) {
        premiumSendMail.sendMailOwnerResetToBene(ArrayUtils.makeStringArray(layer2Name), ArrayUtils.makeStringArray(layer2Email), contractName);
      }
    }

    if (layer == 3) {
      (, string memory layer3Email, string memory layer3Name) = getThirdLineData(legacyAddress);
      if (bytes(layer3Email).length > 0) {
        premiumSendMail.sendMailOwnerResetToBene(ArrayUtils.makeStringArray(layer3Name), ArrayUtils.makeStringArray(layer3Email), contractName);
      }
    }
  }

  function triggerActivationMultisig(address legacyAddress) external onlyRouter {
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddress);

    address creator = legacy.creator();
    (, string memory ownerEmail, ) = getUserData(creator);
    address safeWallet = legacy.getLegacyOwner();
    string memory contractName = legacy.getLegacyName();

    if (!isPremium(creator)) return;
    (, string[] memory beneEmails, string[] memory beneNames) = getBeneficiaryData(legacyAddress);
    if (address(premiumSendMail) == address(0)) return;
    premiumSendMail.sendMailActivatedMultisig(beneNames, beneEmails, contractName, safeWallet);

    (address []  memory  beneficiares ,,) = IPremiumLegacy(legacy).getLegacyBeneficiaries();
    string [] memory names = new string[](beneficiares.length);
     for (uint256 i = 0; i < beneficiares.length; i++) {
        names[i] = IPremiumLegacy(legacy).getBeneNickname(beneficiares[i]);
    }
    premiumSendMail.sendActivatedMutisigToOwner(ownerEmail, contractName, legacyAddress, tx.origin, safeWallet, names, beneficiares);
  }

  function triggerActivationTransferLegacy(
    NotifyLib.ListAsset[] memory listAsset,
    NotifyLib.BeneReceived[] memory _listBeneReceived,
    bool remaining
  ) external onlyLegacy{
    IPremiumLegacy legacy = IPremiumLegacy(msg.sender);
    address creator = legacy.creator();
    address safeWallet = legacy.getLegacyOwner();
    string memory contractName = legacy.getLegacyName();

    if (!isPremium(creator)) return;

    uint8 layerActivated = legacy.getBeneficiaryLayer(tx.origin);

    if (address(premiumSendMail) == address(0)) return;
    (, string memory ownerEmail, ) = getUserData(creator);

    //send email to owner
    if (bytes(ownerEmail).length > 0) {
      premiumSendMail.sendEmailContractActivatedToOwner(
        ownerEmail,
        contractName,
        tx.origin, // the beneficiary that activates legacy
        block.timestamp,
        safeWallet,
        listAsset,
        _listBeneReceived,
        msg.sender, // legacy contract address
        remaining
      );
    }

    //send email to bene
    (address [] memory beneficiaries, address layer2, address layer3) = IPremiumLegacy(msg.sender).getLegacyBeneficiaries();

    address [] memory listToken = new address [](listAsset.length);
    for(uint256 i = 0; i < listAsset.length; i++) {
      listToken[i] = listAsset[i].listToken;
    }
    if( layerActivated ==1) {
      (address [] memory cfgBeneficiaries, string [] memory cfgBeneEmails, string [] memory cfgBeneNames) = getBeneficiaryData(msg.sender);
      for(uint256 i = 0 ; i < cfgBeneficiaries.length ; i++){
        if (cfgBeneficiaries[i] == beneficiaries[i] && bytes(cfgBeneEmails[i]).length >0){
          premiumSendMail.sendEmailActivatedToBene(
            cfgBeneNames[i],
            cfgBeneEmails[i],
            contractName,
            listToken,
            _listBeneReceived[i].listAmount,
            _listBeneReceived[i].listAssetName, 
            msg.sender, //contract address
            remaining
          );
        }
      }
      return;
    }

    if (layerActivated == 2){
      (address cfgLayer2Addr, string memory cfgLayer2Email, string memory cfgLayer2Name) = getSecondLineData(msg.sender);
      if(cfgLayer2Addr == layer2 && bytes(cfgLayer2Email).length >0){
            premiumSendMail.sendEmailActivatedToBene(
            cfgLayer2Name,
            cfgLayer2Email,
            contractName,
            listToken,
            _listBeneReceived[0].listAmount,
            _listBeneReceived[0].listAssetName, 
            msg.sender, //contract address
            remaining
          );
      }
      return;
    }

    //layer 3
    (address cfgLayer3Addr, string memory cfgLayer3Email, string memory cfgLayer3Name) = getThirdLineData(msg.sender);
    if(cfgLayer3Addr == layer3 && bytes(cfgLayer3Email).length > 0) {
        premiumSendMail.sendEmailActivatedToBene(
            cfgLayer3Name,
            cfgLayer3Email,
            contractName,
            listToken,
            _listBeneReceived[0].listAmount,
            _listBeneReceived[0].listAssetName, 
            msg.sender, //contract address
            remaining
          );
    }
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
    require(msg.sender == legacy.creator(), "only legacy creator");
    require(names.length == watchers.length && watchers.length == isFullVisibility.length, "length mismatch");
    require(names.length > 0, "can not set empty");
    emit WatcherUpdated(msg.sender, legacyId, legacyAddress, legacyType, names, watchers, isFullVisibility);
  }

  function clearWatcher(address[] memory legacyAddresses) external onlyPremium(msg.sender) {
    for (uint256 i = 0; i < legacyAddresses.length; i++) {
      IPremiumLegacy legacy = IPremiumLegacy(legacyAddresses[i]);
      (uint256 legacyId, , ) = legacy.getLegacyInfo();
      uint128 legacyType = legacy.LEGACY_TYPE();
      require(msg.sender == legacy.creator(), "only legacy creator");
      emit WatcherReset(msg.sender, legacyId, legacyAddresses[i], legacyType);
    }
  }

  /* INTERNAL FUNCTIONS */
  function _updateUserConfig(address user, string calldata name, string calldata ownerEmail, uint256 timePriorActivation) internal {
    require(timePriorActivation > 0, "timePriorActivation > 0");
    userConfigs[user] = UserConfig({ownerName: name, ownerEmail: ownerEmail, timePriorActivation: timePriorActivation});
    emit UserConfigUpdated(user, name, ownerEmail, timePriorActivation);
  }

  function _updateLegacyConfig(address legacyAddr, LegacyConfig calldata newCfg) internal requireUserConfig(msg.sender) {
    //prepare data
    IPremiumLegacy legacy = IPremiumLegacy(legacyAddr);
    (uint256 legacyId, address owner, ) = legacy.getLegacyInfo();
    uint128 legacyType = legacy.LEGACY_TYPE();

    require(msg.sender == legacy.creator(), "only legacy creator");
    _clearLegacyConfig(legacyAddr);

    // Set cosigners (safe legacy) -> check cosigner valid
    LegacyConfig storage cfg = legacyCfgs[legacyAddr];
    if (newCfg.cosigners.length > 0) {
      require(legacyType != 3, "Only Safe legacy allowed to config cosigners");
      ISafeWallet safe = ISafeWallet(owner);
      require(newCfg.cosigners.length == safe.getOwners().length, "Cosginer length mismatch");
      for (uint256 j = 0; j < newCfg.cosigners.length; j++) {
        address cosigner = newCfg.cosigners[j].addr;
        require(safe.isOwner(cosigner), "invalid cosigner address");
        cfg.cosigners.push(newCfg.cosigners[j]);
      }
    }

    // Set beneficiaries - validate address in legacy by checking distribution
    if (legacyType == 1) {
      address[] memory beneficiaries = legacy.getBeneficiaries();
      for (uint256 j = 0; j < newCfg.beneficiaries.length; j++) {
        address cfgBeneficiary = newCfg.beneficiaries[j].addr;
        require(cfgBeneficiary == beneficiaries[j], "beneficiary not match in legacy");
        cfg.beneficiaries.push(newCfg.beneficiaries[j]);
      }
    } else {
      for (uint256 j = 0; j < newCfg.beneficiaries.length; j++) {
        address beneficiary = newCfg.beneficiaries[j].addr;
        require(legacy.getDistribution(1, beneficiary) != 0, "invalid beneficiary address");
        cfg.beneficiaries.push(newCfg.beneficiaries[j]);
      }
    }

    // Set second and third line - validate address in legacy by checking distribution
    if (newCfg.secondLine.addr == address(0)) {
      require(bytes(newCfg.secondLine.email).length == 0, "secondline invalid pair of address and email");
    } else {
      require(legacy.getDistribution(2, newCfg.secondLine.addr) != 0, "invalid secondline address");
      cfg.secondLine = newCfg.secondLine;
    }
    if (newCfg.thirdLine.addr == address(0)) {
      require(bytes(newCfg.thirdLine.email).length == 0, "thirdline invalid pair of address and email");
    } else {
      require(legacy.getDistribution(3, newCfg.thirdLine.addr) != 0, "invalid thirdline address");
      cfg.thirdLine = newCfg.thirdLine;
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
      require(attempt < 20, "Too many attempts to generate unique code");
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
