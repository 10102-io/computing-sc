// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC721HolderUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/utils/ERC721HolderUpgradeable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {TimelockHelper} from "./TimelockHelper.sol";

contract TimelockERC721 is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable, ERC721HolderUpgradeable {
  // ───────────── Structs ─────────────
  struct TimelockInfo {
    address[] tokenAddresses;
    uint256[] tokenIds;
    address owner;
    address recipient;
    uint256 unlockTime;
    bool isSoftLock;
    bool isUnlocked;
    uint256 bufferTime;
    TimelockHelper.LockType lockType;
    TimelockHelper.LockStatus lockStatus;
    string name;
  }

  // ───────────── Events ─────────────
  event TimelockCreated(
    uint256 indexed timelockId,
    address indexed owner,
    address indexed recipient,
    address[] tokenAddresses,
    uint256[] tokenIds,
    uint256 unlockTime,
    uint256 bufferTime,
    TimelockHelper.LockType lockType,
    string name
  );

  event TimelockGiftName(uint256 indexed timelockId, string giftName, address indexed recipient);
  event SoftTimelockUnlocked(uint256 indexed timelockId, uint256 unlockTime);
  event TokensWithdrawn(uint256 indexed timelockId, address indexed recipient);

  event ChangeStatus(uint256 indexed timelockId, TimelockHelper.LockStatus newStatus);

  // ───────────── State ─────────────
  mapping(uint256 => TimelockInfo) public timelocks;
  address public routerAddresses;

  function onlyRouter() private view {
    if (msg.sender != routerAddresses) revert TimelockHelper.NotAuthorized();
  }

  function setRouterAddresses(address _routerAddresses) external onlyOwner {
    routerAddresses = _routerAddresses;
  }

  // ───────────── Init ─────────────
  function initialize(address initialOwner, address _routerAddresses) public initializer {
    __Ownable_init(initialOwner);
    __ReentrancyGuard_init();
    __ERC721Holder_init();
    routerAddresses = _routerAddresses;
  }

  function _storeTimelock(
    uint256 timelockId,
    address owner,
    address recipient,
    address[] calldata tokens,
    uint256[] calldata ids,
    uint256 unlockTime,
    bool isSoft,
    uint256 buffer,
    TimelockHelper.LockType lockType,
    TimelockHelper.LockStatus lockStatus,
    string calldata name
  ) internal {
    timelocks[timelockId] = TimelockInfo({
      tokenAddresses: tokens,
      tokenIds: ids,
      owner: owner,
      recipient: recipient,
      unlockTime: unlockTime,
      isSoftLock: isSoft,
      isUnlocked: false,
      bufferTime: buffer,
      lockType: lockType,
      lockStatus: lockStatus,
      name: name
    });

    emit TimelockCreated(timelockId, owner, recipient, tokens, ids, unlockTime, buffer, lockType, name);

    emit ChangeStatus(timelockId, lockStatus);
  }

  function _transferTokensOut(address[] memory tokens, uint256[] memory ids, address to) internal {
    for (uint256 i = 0; i < tokens.length; i++) {
      IERC721(tokens[i]).safeTransferFrom(address(this), to, ids[i]);
    }
  }

  function getData(uint256 id) external view returns (address[] memory, uint256[] memory) {
    TimelockInfo memory lock = timelocks[id];
    return (lock.tokenAddresses, lock.tokenIds);
  }

  function getStatus(uint256 id) external view returns (TimelockHelper.LockStatus, address) {
    TimelockInfo memory lock = timelocks[id];

    if (lock.owner == address(0)) return (TimelockHelper.LockStatus.Null, address(0));
    return (lock.lockStatus, lock.owner);
  }


  // ───────────── Create ─────────────
  function createTimelock(
    uint256 timelockId,
    address[] calldata tokens,
    uint256[] calldata ids,
    uint256 duration,
    string calldata name,
    address caller,
    TimelockHelper.LockStatus lockStatus
  ) external nonReentrant {
    onlyRouter();
    _storeTimelock(timelockId, caller, caller, tokens, ids, block.timestamp + duration, false, 0, TimelockHelper.LockType.Regular, lockStatus, name);
  }

  function createSoftTimelock(
    uint256 timelockId,
    address[] calldata tokens,
    uint256[] calldata ids,
    uint256 bufferTime,
    string calldata name,
    address caller,
    TimelockHelper.LockStatus lockStatus
  ) external nonReentrant {
    onlyRouter();
    _storeTimelock(timelockId, caller, caller, tokens, ids, 0, true, bufferTime, TimelockHelper.LockType.Soft, lockStatus, name);
  }

  function createTimelockedGift(
    uint256 timelockId,
    address[] calldata tokens,
    uint256[] calldata ids,
    uint256 duration,
    address recipient,
    string calldata name,
    string calldata giftName,
    address caller,
    TimelockHelper.LockStatus lockStatus
  ) external nonReentrant {
    onlyRouter();
    _storeTimelock(timelockId, caller, recipient, tokens, ids, block.timestamp + duration, false, 0, TimelockHelper.LockType.Gift, lockStatus, name);
    emit TimelockGiftName(timelockId, giftName, recipient);
  }

  // ───────────── Soft Unlock ─────────────
  function unlockSoftTimelock(uint256 timelockId, address caller) external nonReentrant {
    onlyRouter();
    TimelockInfo storage lock = timelocks[timelockId];
    if (lock.owner == address(0)) return;

    if (lock.lockStatus != TimelockHelper.LockStatus.Live) revert TimelockHelper.TimelockNotLive();

    if (caller != lock.owner) revert TimelockHelper.NotAuthorized();
    if (!lock.isSoftLock) revert TimelockHelper.NotSoftTimelock();
    if (lock.isUnlocked) revert TimelockHelper.AlreadyUnlocked();

    lock.isUnlocked = true;
    lock.unlockTime = block.timestamp + lock.bufferTime;

    emit SoftTimelockUnlocked(timelockId, lock.unlockTime);
  }

  // ───────────── Withdraw ─────────────
  function withdraw(uint256 timelockId, address caller) external nonReentrant {
    TimelockInfo storage lock = timelocks[timelockId];

    if (lock.owner == address(0)) return;

    if (lock.lockStatus != TimelockHelper.LockStatus.Live) revert TimelockHelper.TimelockNotLive();
    lock.lockStatus = TimelockHelper.LockStatus.Ended;
    emit ChangeStatus(timelockId, TimelockHelper.LockStatus.Ended);

    if (caller != lock.recipient) revert TimelockHelper.NotAuthorized();
    if (lock.isSoftLock && !lock.isUnlocked) revert TimelockHelper.NotSoftTimelock();
    if (block.timestamp < lock.unlockTime) revert TimelockHelper.StillLocked();
    if (lock.tokenIds.length == 0) revert TimelockHelper.NoTokensToLock();

    address[] memory tokens = lock.tokenAddresses;
    uint256[] memory ids = lock.tokenIds;

    delete lock.tokenAddresses;
    delete lock.tokenIds;

    _transferTokensOut(tokens, ids, caller);

    emit TokensWithdrawn(timelockId, caller);
  }

  // ───────────── View ─────────────
  function getTimelockDetails(uint256 timelockId) external view returns (TimelockInfo memory) {
    return timelocks[timelockId];
  }
}
