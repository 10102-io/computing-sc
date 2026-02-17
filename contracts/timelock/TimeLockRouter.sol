// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {TimelockERC20} from "./TimeLockERC20.sol";
import {TimelockERC721} from "./TimeLockERC721.sol";
import {TimelockERC1155} from "./TimeLockERC1155.sol";

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {TimelockHelper} from "./TimelockHelper.sol";
import {ITokenWhiteList} from "../interfaces/ITokenWhiteList.sol";
import {IUniswapV2Router02} from "../interfaces/IUniswapV2Router02.sol";
import {IWETH} from "../interfaces/IWETH.sol";

contract TimeLockRouter is OwnableUpgradeable {
  using SafeERC20 for IERC20;

  struct TimelockERC20InputData {
    address tokenAddress;
    uint256 amount;
  }

  struct TimelockETHSwapInputData {
    address storageToken;
    uint256 amountOutMin;
    uint256 deadline;
  }

  struct TimelockERC721InputData {
    address tokenAddress;
    uint256 id;
  }

  struct TimelockERC1155InputData {
    address tokenAddress;
    uint256 id;
    uint256 amount;
  }

  struct TimelockRegular {
    TimelockETHSwapInputData timelockETHSwap;
    TimelockERC20InputData[] timelockERC20;
    TimelockERC721InputData[] timelockERC721;
    TimelockERC1155InputData[] timelockERC1155;
    uint256 duration;
    string name;
  }

  struct TimelockSoft {
    TimelockETHSwapInputData timelockETHSwap;
    TimelockERC20InputData[] timelockERC20;
    TimelockERC721InputData[] timelockERC721;
    TimelockERC1155InputData[] timelockERC1155;
    uint256 bufferTime;
    string name;
  }

  struct TimelockGift {
    TimelockETHSwapInputData timelockETHSwap;
    TimelockERC20InputData[] timelockERC20;
    TimelockERC721InputData[] timelockERC721;
    TimelockERC1155InputData[] timelockERC1155;
    uint256 duration;
    address recipient;
    string name;
    string giftName;
  }

  TimelockERC20 public timelockERC20Contract;
  TimelockERC721 public timelockERC721Contract;
  TimelockERC1155 public timelockERC1155Contract;

  ITokenWhiteList public tokenWhitelist;
  IUniswapV2Router02 public uniswapRouter;

  uint256 public timelockCounter;
  address internal constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
  bytes4 private constant IERC721_ID = 0x80ac58cd;
  bytes4 private constant IERC1155_ID = 0xd9b67a26;

  // ───────────── Native Token Receive ─────────────
  receive() external payable {}

  function initialize(address initialOwner) external initializer {
    __Ownable_init(initialOwner);
  }

  function setTimelock(address payable _timelockERC20, address payable _timelockERC721, address payable _timelockERC1155) external onlyOwner {
    timelockERC20Contract = TimelockERC20(_timelockERC20);
    timelockERC721Contract = TimelockERC721(_timelockERC721);
    timelockERC1155Contract = TimelockERC1155(_timelockERC1155);
  }

  function setTokenWhitelist(address _tokenWhitelist) external onlyOwner {
    tokenWhitelist = ITokenWhiteList(_tokenWhitelist);
  }

  function setUniswapRouter(address _uniswapRouter) external onlyOwner {
    uniswapRouter = IUniswapV2Router02(_uniswapRouter);
  }

  /// @param ethAmountWei Amount of ETH in wei (e.g. msg.value).
  /// @param storageToken The ERC-20 token address to receive.
  /// @return Expected amount of outputToken (in its smallest units) for the given ETH.
  function getEthToTokenAmountOut(uint256 ethAmountWei, address storageToken) external view returns (uint256) {
    if (address(uniswapRouter) == address(0)) revert TimelockHelper.SwapNotConfigured();
    address weth = uniswapRouter.WETH();
    if (storageToken == weth) return ethAmountWei; // ETH→WETH is 1:1 wrap
    address[] memory path = new address[](2);
    path[0] = weth;
    path[1] = storageToken;
    uint256[] memory amounts = uniswapRouter.getAmountsOut(ethAmountWei, path);
    return amounts[1];
  }

  /// @param tokenAmount Amount of token (in its smallest units).
  /// @param storageToken The ERC-20 token address to swap.
  /// @return Expected amount of ETH in wei received for the given token amount.
  function getTokenToEthAmountOut(uint256 tokenAmount, address storageToken) external view returns (uint256) {
    if (address(uniswapRouter) == address(0)) revert TimelockHelper.SwapNotConfigured();
    address weth = uniswapRouter.WETH();
    if (storageToken == weth) return tokenAmount; // WETH→ETH is 1:1 unwrap
    address[] memory path = new address[](2);
    path[0] = storageToken;
    path[1] = weth;
    uint256[] memory amounts = uniswapRouter.getAmountsOut(tokenAmount, path);
    return amounts[1];
  }

  function createTimelock(TimelockRegular calldata timelockRegular) external payable {
    if (timelockRegular.duration == 0) revert TimelockHelper.ZeroDuration();

    timelockCounter++;

    if (timelockRegular.timelockERC20.length > 0 || timelockRegular.timelockETHSwap.storageToken != address(0)) {
      _handleTimelockRegularERC20(
        timelockCounter,
        timelockRegular.timelockETHSwap,
        timelockRegular.timelockERC20,
        timelockRegular.duration,
        timelockRegular.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
    if (timelockRegular.timelockERC721.length > 0) {
      _handleTimelockRegularERC721(
        timelockCounter,
        timelockRegular.timelockERC721,
        timelockRegular.duration,
        timelockRegular.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
    if (timelockRegular.timelockERC1155.length > 0) {
      _handleTimelockRegularERC1155(
        timelockCounter,
        timelockRegular.timelockERC1155,
        timelockRegular.duration,
        timelockRegular.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
  }

  function getStatusOwner(uint256 id) public view returns (TimelockHelper.LockStatus, address) {
    (TimelockHelper.LockStatus status, address owner) = timelockERC20Contract.getStatus(id);
    if (status == TimelockHelper.LockStatus.Null) {
      (status, owner) = timelockERC721Contract.getStatus(id);
    }
    if (status == TimelockHelper.LockStatus.Null) {
      (status, owner) = timelockERC1155Contract.getStatus(id);
    }
    return (status, owner);
  }

  function createSoftTimelock(TimelockSoft calldata timelockSoft) external payable {
    if (timelockSoft.bufferTime == 0) revert TimelockHelper.ZeroBufferTime();

    timelockCounter++;

    if (timelockSoft.timelockERC20.length > 0 || timelockSoft.timelockETHSwap.storageToken != address(0)) {
      _handleTimelockSoftERC20(
        timelockCounter,
        timelockSoft.timelockETHSwap,
        timelockSoft.timelockERC20,
        timelockSoft.bufferTime,
        timelockSoft.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
    if (timelockSoft.timelockERC721.length > 0) {
      _handleTimelockSoftERC721(
        timelockCounter,
        timelockSoft.timelockERC721,
        timelockSoft.bufferTime,
        timelockSoft.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }

    if (timelockSoft.timelockERC1155.length > 0) {
      _handleTimelockSoftERC1155(
        timelockCounter,
        timelockSoft.timelockERC1155,
        timelockSoft.bufferTime,
        timelockSoft.name,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
  }


  function createTimelockedGift(TimelockGift calldata timelockGift) external payable {
    if (timelockGift.duration == 0) revert TimelockHelper.ZeroDuration();
    if (timelockGift.recipient == address(0)) revert TimelockHelper.InvalidRecipient();

    timelockCounter++;

    if (timelockGift.timelockERC20.length > 0 || timelockGift.timelockETHSwap.storageToken != address(0)) {
      _handleTimelockGiftERC20(
        timelockCounter,
        timelockGift.timelockETHSwap,
        timelockGift.timelockERC20,
        timelockGift.duration,
        timelockGift.recipient,
        timelockGift.name,
        timelockGift.giftName,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
    if (timelockGift.timelockERC721.length > 0) {
      _handleTimelockGiftERC721(
        timelockCounter,
        timelockGift.timelockERC721,
        timelockGift.duration,
        timelockGift.recipient,
        timelockGift.name,
        timelockGift.giftName,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
    if (timelockGift.timelockERC1155.length > 0) {
      _handleTimelockGiftERC1155(
        timelockCounter,
        timelockGift.timelockERC1155,
        timelockGift.duration,
        timelockGift.recipient,
        timelockGift.name,
        timelockGift.giftName,
        msg.sender,
        TimelockHelper.LockStatus.Live
      );
    }
  }

  function unlockSoftTimelock(uint256 id) external {
    timelockERC20Contract.unlockSoftTimelock(id, msg.sender);
    timelockERC721Contract.unlockSoftTimelock(id, msg.sender);
    timelockERC1155Contract.unlockSoftTimelock(id, msg.sender);
  }

  function withdraw(uint256 id) external {
    timelockERC20Contract.withdraw(id, msg.sender);
    timelockERC721Contract.withdraw(id, msg.sender);
    timelockERC1155Contract.withdraw(id, msg.sender);
  }

  // ───────────── private ─────────────
  // ********** Regular **********

  // regular ERC20

  function _makeListERC20(TimelockERC20InputData[] calldata timelockERC20) private pure returns (address[] memory tokens, uint256[] memory amounts) {
    tokens = new address[](timelockERC20.length);
    amounts = new uint256[](timelockERC20.length);
    for (uint256 i = 0; i < timelockERC20.length; i++) {
      tokens[i] = timelockERC20[i].tokenAddress;
      amounts[i] = timelockERC20[i].amount;
    }
  }

  /// @dev Validates swap intent and user ERC20 list; reverts on invalid input. No state changes, no transfers.
  function _validateERC20LockInput(
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20
  ) private view {
    if (timelockETHSwap.storageToken != address(0)) {
      if (msg.value == 0) revert TimelockHelper.InvalidSwapIntent();
      if (timelockERC20.length > 0) {
        (address[] memory tokens, uint256[] memory amounts) = _makeListERC20(timelockERC20);
        _validateERC20Input(tokens, amounts);
        for (uint256 i = 0; i < tokens.length; i++) {
          if (tokens[i] == timelockETHSwap.storageToken) revert TimelockHelper.DuplicateTokenAddress();
        }
      }
    } else {
      if (msg.value != 0) revert TimelockHelper.EthSentWithoutSwap();
      (address[] memory tokens, uint256[] memory amounts) = _makeListERC20(timelockERC20);
      _validateERC20Input(tokens, amounts);
    }
  }

  /// @dev Builds (tokens, amounts, withdrawAsEthToken) layout. No validation, swap, or transfers. When swap required, last amount is 0 until filled.
  function _buildERC20LockArrays(
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20
  ) private pure returns (address[] memory tokens, uint256[] memory amounts, address withdrawAsEthToken) {
    address storageToken = timelockETHSwap.storageToken;
    if (storageToken != address(0) && timelockERC20.length == 0) {
      tokens = new address[](1);
      amounts = new uint256[](1);
      tokens[0] = storageToken;
      amounts[0] = 0;
      return (tokens, amounts, storageToken);
    }
    if (storageToken != address(0)) {
      (address[] memory listTokens, uint256[] memory listAmounts) = _makeListERC20(timelockERC20);
      uint256 n = listTokens.length + 1;
      tokens = new address[](n);
      amounts = new uint256[](n);
      for (uint256 i = 0; i < listTokens.length; i++) {
        tokens[i] = listTokens[i];
        amounts[i] = listAmounts[i];
      }
      tokens[listTokens.length] = storageToken;
      amounts[listTokens.length] = 0;
      return (tokens, amounts, storageToken);
    }
    (tokens, amounts) = _makeListERC20(timelockERC20);
    return (tokens, amounts, address(0));
  }

  function _executeEthSwapForToken(TimelockETHSwapInputData calldata timelockETHSwap) private returns (address outputToken, uint256 receivedAmount) {
    if (address(uniswapRouter) == address(0)) revert TimelockHelper.SwapNotConfigured();
    if (address(tokenWhitelist) != address(0) && !tokenWhitelist.isWhitelisted(timelockETHSwap.storageToken)) {
      revert TimelockHelper.TokenNotWhitelisted();
    }
    if (timelockETHSwap.deadline < block.timestamp) revert TimelockHelper.InvalidSwapIntent();
    if (msg.value == 0) revert TimelockHelper.InvalidSwapIntent();

    address weth = uniswapRouter.WETH();
    if (timelockETHSwap.storageToken == weth) {
      // ETH→WETH is 1:1 wrap; use WETH.deposit instead of Uniswap
      IWETH(weth).deposit{value: msg.value}();
      SafeERC20.safeTransfer(IERC20(weth), address(timelockERC20Contract), msg.value);
      return (weth, msg.value);
    }

    address[] memory path = new address[](2);
    path[0] = weth;
    path[1] = timelockETHSwap.storageToken;

    uint256 balanceBefore = IERC20(timelockETHSwap.storageToken).balanceOf(address(timelockERC20Contract));
    uniswapRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: msg.value}(
      timelockETHSwap.amountOutMin,
      path,
      address(timelockERC20Contract),
      timelockETHSwap.deadline
    );
    uint256 balanceAfter = IERC20(timelockETHSwap.storageToken).balanceOf(address(timelockERC20Contract));
    if (balanceAfter <= balanceBefore) revert TimelockHelper.NoTokensReceived();
    receivedAmount = balanceAfter - balanceBefore;
    return (timelockETHSwap.storageToken, receivedAmount);
  }

  /// @dev Validates, then builds arrays, executes swap if required, transfers user ERC20s if required. Returns lock assets for timelock.
  function _resolveERC20LockAssets(
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20
  ) private returns (address[] memory tokens, uint256[] memory amounts, address withdrawAsEthToken) {
    _validateERC20LockInput(timelockETHSwap, timelockERC20);
    (tokens, amounts, withdrawAsEthToken) = _buildERC20LockArrays(timelockETHSwap, timelockERC20);

    // If the storage token is defined, swap ETH for it and update the tokens and amounts arrays
    if (withdrawAsEthToken != address(0)) {
      (address swapToken, uint256 swapAmount) = _executeEthSwapForToken(timelockETHSwap);
      tokens[tokens.length - 1] = swapToken;
      amounts[amounts.length - 1] = swapAmount;
    }

    // Transfer the user ERC20s to the timelock
    uint256 numUserTransfers = withdrawAsEthToken != address(0) ? tokens.length - 1 : tokens.length;
    if (numUserTransfers > 0) {
      uint256[] memory actualReceived = _transferERC20TokensToTimelock(tokens, amounts, numUserTransfers);
      for (uint256 i = 0; i < numUserTransfers; i++) {
        amounts[i] = actualReceived[i];
      }
    }

    return (tokens, amounts, withdrawAsEthToken);
  }

  function _handleTimelockRegularERC20(
    uint256 timelockId,
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20,
    uint256 duration,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory amounts, address withdrawAsEthToken) =
      _resolveERC20LockAssets(timelockETHSwap, timelockERC20);
    timelockERC20Contract.createTimelock{value: 0}(timelockId, tokens, amounts, duration, name, owner, lockStatus, withdrawAsEthToken);
  }

  function _handleTimelockSoftERC20(
    uint256 timelockId,
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20,
    uint256 bufferTime,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory amounts, address withdrawAsEthToken) =
      _resolveERC20LockAssets(timelockETHSwap, timelockERC20);
    timelockERC20Contract.createSoftTimelock{value: 0}(timelockId, tokens, amounts, bufferTime, name, owner, lockStatus, withdrawAsEthToken);
  }

  function _handleTimelockGiftERC20(
    uint256 timelockId,
    TimelockETHSwapInputData calldata timelockETHSwap,
    TimelockERC20InputData[] calldata timelockERC20,
    uint256 duration,
    address recipient,
    string calldata name,
    string calldata giftName,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory amounts, address withdrawAsEthToken) =
      _resolveERC20LockAssets(timelockETHSwap, timelockERC20);
    timelockERC20Contract.createTimelockedGift{value: 0}(timelockId, tokens, amounts, duration, recipient, name, giftName, owner, lockStatus, withdrawAsEthToken);
  }

  /// @dev Transfers first `count` tokens from msg.sender to timelock; returns actual amounts received (fee-on-transfer safe).
  function _transferERC20TokensToTimelock(
    address[] memory tokens,
    uint256[] memory amounts,
    uint256 count
  ) private returns (uint256[] memory actualReceived) {
    actualReceived = new uint256[](count);
    for (uint256 i = 0; i < count; i++) {
      uint256 balanceBefore = IERC20(tokens[i]).balanceOf(address(timelockERC20Contract));
      IERC20(tokens[i]).safeTransferFrom(msg.sender, address(timelockERC20Contract), amounts[i]);
      uint256 balanceAfter = IERC20(tokens[i]).balanceOf(address(timelockERC20Contract));
      if (balanceAfter <= balanceBefore) revert TimelockHelper.NoTokensReceived();
      actualReceived[i] = balanceAfter - balanceBefore;
    }
  }

  function _validateERC20Input(address[] memory tokens, uint256[] memory amounts) private pure {
    if (tokens.length == 0 || tokens.length != amounts.length) revert TimelockHelper.MismatchedArrayLength();

    for (uint256 i = 0; i < tokens.length; i++) {
      if (amounts[i] == 0) revert TimelockHelper.InvalidTokenAmount();
      if (tokens[i] == NATIVE_TOKEN) revert TimelockHelper.NativeLockDeprecated();
    }

    for (uint256 i = 0; i < tokens.length; i++) {
      for (uint256 j = i + 1; j < tokens.length; j++) {
        if (tokens[i] == tokens[j]) revert TimelockHelper.DuplicateTokenAddress();
      }
    }


  }

  // regular ERC721

  function _makeListERC721(TimelockERC721InputData[] calldata timelockERC721) private pure returns (address[] memory tokens, uint256[] memory ids) {
    tokens = new address[](timelockERC721.length);
    ids = new uint256[](timelockERC721.length);
    for (uint256 i = 0; i < timelockERC721.length; i++) {
      tokens[i] = timelockERC721[i].tokenAddress;
      ids[i] = timelockERC721[i].id;
    }
  }

  function _handleTimelockRegularERC721(
    uint256 timelockId,
    TimelockERC721InputData[] calldata timelockERC721,
    uint256 duration,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids) = _makeListERC721(timelockERC721);
    _validateERC721Input(tokens, ids);
    _transferERC721TokensIn(tokens, ids);
    timelockERC721Contract.createTimelock(timelockId, tokens, ids, duration, name, owner, lockStatus);
  }

  function _handleTimelockSoftERC721(
    uint256 timelockId,
    TimelockERC721InputData[] calldata timelockERC721,
    uint256 bufferTime,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids) = _makeListERC721(timelockERC721);

    _validateERC721Input(tokens, ids);
    _transferERC721TokensIn(tokens, ids);
    
    timelockERC721Contract.createSoftTimelock(timelockId, tokens, ids, bufferTime, name, owner, lockStatus);
  }

  function _handleTimelockGiftERC721(
    uint256 timelockId,
    TimelockERC721InputData[] calldata timelockERC721,
    uint256 duration,
    address recipient,
    string calldata name,
    string calldata giftName,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids) = _makeListERC721(timelockERC721);

    _validateERC721Input(tokens, ids);
    _transferERC721TokensIn(tokens, ids);

    timelockERC721Contract.createTimelockedGift(timelockId, tokens, ids, duration, recipient, name, giftName, owner, lockStatus);
  }

  function _transferERC721TokensIn(address[] memory tokens, uint256[] memory ids) private {
    for (uint256 i = 0; i < tokens.length; i++) {
      IERC721(tokens[i]).safeTransferFrom(msg.sender, address(timelockERC721Contract), ids[i]);
    }
  }

  function _validateERC721(address token) private view {
    if (!IERC165(token).supportsInterface(IERC721_ID)) revert TimelockHelper.InvalidTokenType();
  }

  function _validateERC721Input(address[] memory tokens, uint256[] memory ids) private view {
    if (msg.value > 0) revert TimelockHelper.EthSentWithoutSwap();
    if (tokens.length == 0 || tokens.length != ids.length) revert TimelockHelper.MismatchedArrayLength();
    for (uint256 i = 0; i < tokens.length; i++) {
      _validateERC721(tokens[i]);
      for (uint256 j = i + 1; j < tokens.length; j++) {
        if (tokens[i] == tokens[j] && ids[i] == ids[j]) revert TimelockHelper.DuplicateTokenAddresses();
      }
    }
  }

  // regular ERC1155

  function _makeListERC1155(
    TimelockERC1155InputData[] calldata timelockERC1155
  ) private pure returns (address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) {
    tokens = new address[](timelockERC1155.length);
    ids = new uint256[](timelockERC1155.length);
    amounts = new uint256[](timelockERC1155.length);
    for (uint256 i = 0; i < timelockERC1155.length; i++) {
      tokens[i] = timelockERC1155[i].tokenAddress;
      ids[i] = timelockERC1155[i].id;
      amounts[i] = timelockERC1155[i].amount;
    }
  }

  function _handleTimelockRegularERC1155(
    uint256 timelockId,
    TimelockERC1155InputData[] calldata timelockERC1155,
    uint256 duration,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) = _makeListERC1155(timelockERC1155);

    _validateERC1155Input(tokens, ids, amounts);
    _transferERC1155TokensIn(tokens, ids, amounts);
    timelockERC1155Contract.createTimelock(timelockId, tokens, ids, amounts, duration, name, owner, lockStatus);
  }

  function _handleTimelockSoftERC1155(
    uint256 timelockId,
    TimelockERC1155InputData[] calldata timelockERC1155,
    uint256 bufferTime,
    string calldata name,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) = _makeListERC1155(timelockERC1155);

    _validateERC1155Input(tokens, ids, amounts);
    _transferERC1155TokensIn(tokens, ids, amounts);
    timelockERC1155Contract.createSoftTimelock(timelockId, tokens, ids, amounts, bufferTime, name, owner, lockStatus);
  }

  function _handleTimelockGiftERC1155(
    uint256 timelockId,
    TimelockERC1155InputData[] calldata timelockERC1155,
    uint256 duration,
    address recipient,
    string calldata name,
    string calldata giftName,
    address owner,
    TimelockHelper.LockStatus lockStatus
  ) private {
    (address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) = _makeListERC1155(timelockERC1155);

    _validateERC1155Input(tokens, ids, amounts);
    _transferERC1155TokensIn(tokens, ids, amounts);

    timelockERC1155Contract.createTimelockedGift(timelockId, tokens, ids, amounts, duration, recipient, name, giftName, owner, lockStatus);
  }

  function _transferERC1155TokensIn(address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) private {
    for (uint256 i = 0; i < tokens.length; i++) {
      IERC1155(tokens[i]).safeTransferFrom(msg.sender, address(timelockERC1155Contract), ids[i], amounts[i], "");
    }
  }

  function _validateERC1155(address token) private view {
    if (!IERC165(token).supportsInterface(IERC1155_ID)) revert TimelockHelper.InvalidTokenType();
  }

  function _validateERC1155Input(address[] memory tokens, uint256[] memory ids, uint256[] memory amounts) private view {
    if (msg.value > 0) revert TimelockHelper.EthSentWithoutSwap();
    if (tokens.length == 0 || tokens.length != ids.length || ids.length != amounts.length) revert TimelockHelper.MismatchedArrayLength();
    for (uint256 i = 0; i < amounts.length; i++) {
      if (amounts[i] == 0) revert TimelockHelper.ZeroAmount();
    }
    for (uint256 i = 0; i < tokens.length; i++) {
      _validateERC1155(tokens[i]);
      for (uint256 j = i + 1; j < tokens.length; j++) {
        if (tokens[i] == tokens[j] && ids[i] == ids[j]) revert TimelockHelper.DuplicateTokenAddresses();
      }
    }
  }
}
