// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

contract GenericLegacy {

  event EmailActivatedNotCompleted(address legacyAddress);

  /* Error */
  error OnlyRouter();
  error OnlyOwner();
  error LegacyAlreadyInitialized();
  error LegacyNotActive();
  error OwnerInvalid();

  /* State variable */
  uint256 private _legacyId;
  address private _owner;
  uint128 private _isActive;
  uint256 private _lackOfOutgoingTxRange;
  address public router;
  string private legacyName;
  mapping (address => string) private beneName;
  // `constant` so it lives in code rather than storage. Inline storage initializers
  // only run during full contract creation (CREATE/CREATE2 bytecode path); they do
  // NOT run for EIP-1167 minimal-proxy clones, which would otherwise read 0 here
  // and revert every distribution check.
  uint256 internal constant MAX_PERCENT = 1000000;

  /* Modifier */
  modifier onlyRouter() {
    if (msg.sender != router) revert OnlyRouter();
    _;
  }

  modifier onlyOwner(address sender_) {
    if (sender_ != _owner) revert OnlyOwner();
    _;
  }

  modifier notInitialized() {
    if (_owner != address(0)) revert LegacyAlreadyInitialized();
    _;
  }

  modifier isActiveLegacy() {
    if (_isActive == 2) revert LegacyNotActive();
    _;
  }

  /* Public function */
  /**
   * @dev Get legacy infomation
   * @return legacyId
   * @return owner
   * @return isActive
   */
  function getLegacyInfo() public view returns (uint256, address, uint128) {
    return (_legacyId, _owner, _isActive);
  }

  /**
   * @dev Get legacy owner
   */
  function getLegacyOwner() public view returns (address) {
    return _owner;
  }

  /**
   * @dev Get is active legacy
   */
  function getIsActiveLegacy() public view returns (uint128) {
    return _isActive;
  }

  /**
   * @dev Get lackOfOutgoingTxRange
   */
  function getActivationTrigger() public view returns (uint256) {
    return _lackOfOutgoingTxRange;
  }

  /* Internal function */
  /**
   * @dev Set legacy info
   * @param legacyId_ legacy id
   * @param owner_ legacy owner
   * @param isActive_ isActive
   * @param lackOfOutgoingTxRange_ lackOfOutgoingTxRange
   * @param router_ router
   */
  function _setLegacyInfo(uint256 legacyId_, address owner_, uint128 isActive_, uint256 lackOfOutgoingTxRange_, address router_) internal {
    _legacyId = legacyId_;
    _owner = owner_;
    _isActive = isActive_;
    _lackOfOutgoingTxRange = lackOfOutgoingTxRange_;
    router = router_;
  }

  /**
   * @dev Set lackOfOutgoingTxRange legacy
   * @param lackOfOutgoingTxRange_  lackOfOutgoingTxRange
   */
  function _setActivationTrigger(uint256 lackOfOutgoingTxRange_) internal {
    _lackOfOutgoingTxRange = lackOfOutgoingTxRange_;
  }

  /**
   * @dev Inactive legacy
   */
  function _setLegacyToInactive() internal {
    _isActive = 2;
  }

  function _setLegacyName(string calldata _legacyName) internal {
    legacyName = _legacyName;
  }

  function _setBeneNickname(address beneAddress, string calldata _beneName) internal {
    beneName[beneAddress] = _beneName;
  }

  function _deleteBeneName(address beneAddress) internal {
    delete beneName[beneAddress];
  }

  function getLegacyId() public view returns (uint256) {
    return _legacyId;
  }

  ///@dev false if legacy has been deleted or activate
  function isLive() public view virtual returns (bool) {}

  ///@dev return beneficiary address  list
  function getLegacyBeneficiaries() public view virtual returns (address[] memory beneficiaries, address layer2, address layer3) {}

  ///@dev get the timestamp when activation can be triggered
  function getTriggerActivationTimestamp() public view virtual returns (uint256 beneficiariesTrigger, uint256 layer2Trigger, uint256 layer3Trigger) {}

  ///@dev return current layer for all legacy types
  function getLayer() public view virtual returns (uint8) {
    return 1; //default layer
  }

  function getLegacyName() public view returns (string memory) {
    return legacyName;
  }

  function getLastTimestamp () public virtual view returns (uint256) {}

  function getBeneNickname(address beneAddress) public view returns (string memory){
    return beneName[beneAddress];
  }
}
