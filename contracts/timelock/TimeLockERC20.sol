// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TimelockHelper} from "./TimelockHelper.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {IWETH} from "../interfaces/IWETH.sol";

contract TimelockERC20 is Initializable, ReentrancyGuardUpgradeable, OwnableUpgradeable {
  using SafeERC20 for IERC20;

  // ───────────── Constants ─────────────
  address internal constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

  // ───────────── Struct ─────────────
  struct TimelockInfo {
    address[] tokenAddresses;
    uint256[] amounts;
    /// @dev If set, this token is swapped to ETH on withdraw; otherwise address(0).
    address withdrawAsEthToken;
    uint256 unlockTime;
    address owner;
    address recipient;
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
    uint256[] amounts,
    uint256 unlockTime,
    uint256 bufferTime,
    TimelockHelper.LockType lockType,
    string name
  );

  event TimelockGiftName(uint256 indexed timelockId, string giftName, address indexed recipient);

  event SoftTimelockUnlocked(uint256 indexed timelockId, uint256 newUnlockTime);
  event FundsWithdrawn(uint256 indexed timelockId, address indexed recipient);

  event ChangeStatus(uint256 indexed timelockId, TimelockHelper.LockStatus newStatus);

  // ───────────── Storage ─────────────
  mapping(uint256 => TimelockInfo) public timelocks;
  address public routerAddresses;
  IUniswapV2Router02 public uniswapRouter;

  uint256 private constant WITHDRAW_SWAP_DEADLINE_BUFFER = 300;

  function onlyRouter() private view {
    if (msg.sender != routerAddresses) revert TimelockHelper.NotAuthorized();
  }

  function setUniswapRouter(address _uniswapRouter) external onlyOwner {
    uniswapRouter = IUniswapV2Router02(_uniswapRouter);
  }

  function setRouterAddresses(address _routerAddresses) external onlyOwner {
    routerAddresses = _routerAddresses;
  }

  // ───────────── Init ─────────────
  function initialize(address initialOwner, address _routerAddresses) public initializer {
    __Ownable_init(initialOwner);
    __ReentrancyGuard_init();
    routerAddresses = _routerAddresses;
  }

  function getData(uint256 id) external view returns (address[] memory, uint256[] memory) {
    TimelockInfo memory lock = timelocks[id];
    return (lock.tokenAddresses, lock.amounts);
  }

  function getStatus(uint256 id) external view returns (TimelockHelper.LockStatus, address) {
    TimelockInfo memory lock = timelocks[id];

    if (lock.owner == address(0)) return (TimelockHelper.LockStatus.Null, address(0));
    return (lock.lockStatus, lock.owner);
  }


  // ───────────── Create ─────────────
  function createTimelock(
    uint256 id,
    address[] calldata tokens,
    uint256[] calldata amounts,
    uint256 duration,
    string calldata name,
    address caller,
    TimelockHelper.LockStatus lockStatus,
    address withdrawAsEthToken
  ) external payable nonReentrant {
    onlyRouter();
    _createTimelock(id, tokens, amounts, withdrawAsEthToken, caller, caller, block.timestamp + duration, false, 0, TimelockHelper.LockType.Regular, lockStatus, name);
  }

  function createSoftTimelock(
    uint256 id,
    address[] calldata tokens,
    uint256[] calldata amounts,
    uint256 bufferTime,
    string calldata name,
    address caller,
    TimelockHelper.LockStatus lockStatus,
    address withdrawAsEthToken
  ) external payable nonReentrant {
    onlyRouter();
    _createTimelock(id, tokens, amounts, withdrawAsEthToken, caller, caller, 0, true, bufferTime, TimelockHelper.LockType.Soft, lockStatus, name);
  }

  function createTimelockedGift(
    uint256 id,
    address[] calldata tokens,
    uint256[] calldata amounts,
    uint256 duration,
    address recipient,
    string calldata name,
    string calldata giftName,
    address owner,
    TimelockHelper.LockStatus lockStatus,
    address withdrawAsEthToken
  ) external payable nonReentrant {
    onlyRouter();
    _createTimelock(id, tokens, amounts, withdrawAsEthToken, owner, recipient, block.timestamp + duration, false, 0, TimelockHelper.LockType.Gift, lockStatus, name);
    emit TimelockGiftName(id, giftName, recipient);
  }

  function _createTimelock(
    uint256 id,
    address[] calldata tokens,
    uint256[] calldata amounts,
    address withdrawAsEthToken,
    address owner,
    address recipient,
    uint256 unlockTime,
    bool isSoft,
    uint256 buffer,
    TimelockHelper.LockType lockType,
    TimelockHelper.LockStatus lockStatus,
    string memory name
  ) internal {
    timelocks[id] = TimelockInfo({
      tokenAddresses: tokens,
      amounts: amounts,
      withdrawAsEthToken: withdrawAsEthToken,
      unlockTime: unlockTime,
      owner: owner,
      recipient: recipient,
      isSoftLock: isSoft,
      isUnlocked: false,
      bufferTime: buffer,
      lockType: lockType,
      lockStatus: lockStatus,
      name: name
    });

    emit TimelockCreated(id, owner, recipient, tokens, amounts, unlockTime, buffer, lockType, name);

    emit ChangeStatus(id, lockStatus);
  }

  // ───────────── Soft Unlock ─────────────
  function unlockSoftTimelock(uint256 id, address caller) external nonReentrant {
    onlyRouter();
    TimelockInfo storage lock = timelocks[id];
    if (lock.owner == address(0)) return;
    if (lock.lockStatus != TimelockHelper.LockStatus.Live) revert TimelockHelper.TimelockNotLive();

    if (!lock.isSoftLock) revert TimelockHelper.NotSoftTimelock();
    if (lock.owner != caller) revert TimelockHelper.NotOwner();
    if (lock.isUnlocked) revert TimelockHelper.AlreadyUnlocked();

    lock.isUnlocked = true;
    lock.unlockTime = block.timestamp + lock.bufferTime;

    emit SoftTimelockUnlocked(id, lock.unlockTime);
  }

  // ───────────── Withdraw ─────────────
  function withdraw(uint256 id, address caller) external nonReentrant {
    TimelockInfo storage lock = timelocks[id];

    if (lock.owner == address(0)) return;

    if (lock.lockStatus != TimelockHelper.LockStatus.Live) revert TimelockHelper.TimelockNotLive();
    lock.lockStatus = TimelockHelper.LockStatus.Ended;
    emit ChangeStatus(id, TimelockHelper.LockStatus.Ended);

    if (caller != lock.recipient) revert TimelockHelper.NotAuthorized();
    if (lock.isSoftLock && !lock.isUnlocked) revert TimelockHelper.NotSoftTimelock();
    if (block.timestamp < lock.unlockTime) revert TimelockHelper.StillLocked();
    if (lock.tokenAddresses.length == 0) revert TimelockHelper.NoFundsToWithdraw();

    address[] memory tokens = lock.tokenAddresses;
    uint256[] memory amounts = lock.amounts;
    address withdrawAsEthToken = lock.withdrawAsEthToken;

    delete lock.tokenAddresses;
    delete lock.amounts;
    lock.withdrawAsEthToken = address(0);

    for (uint256 i = 0; i < tokens.length; i++) {
      if (tokens[i] == withdrawAsEthToken) {
        _swapTokenToEthAndSend(tokens[i], amounts[i], lock.recipient);
      } else {
        IERC20(tokens[i]).safeTransfer(lock.recipient, amounts[i]);
      }
    }

    emit FundsWithdrawn(id, lock.recipient);
  }

  function _swapTokenToEthAndSend(address token, uint256 amount, address recipient) internal {
    address weth = address(uniswapRouter) != address(0) ? uniswapRouter.WETH() : address(0);
    if (token == weth) {
      // WETH→ETH is 1:1 unwrap
      IWETH(token).withdraw(amount);
      (bool ok,) = recipient.call{value: amount}("");
      if (!ok) revert TimelockHelper.NativeTokenTransferFailed();
      return;
    }
    if (address(uniswapRouter) == address(0)) {
      IERC20(token).safeTransfer(recipient, amount);
      return;
    }
    address[] memory path = new address[](2);
    path[0] = token;
    path[1] = weth;
    IERC20(token).forceApprove(address(uniswapRouter), amount);
    uniswapRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amount,
      0,
      path,
      recipient,
      block.timestamp + WITHDRAW_SWAP_DEADLINE_BUFFER
    );
  }

  // ───────────── View ─────────────
  function getTimelockDetails(uint256 id) external view returns (TimelockInfo memory) {
    return timelocks[id];
  }

  // ───────────── Native Token Receive ─────────────
  receive() external payable {}
}
