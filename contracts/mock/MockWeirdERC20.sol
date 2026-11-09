// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only ERC-20 with the hostile behaviours the 2026-11 reviews
 * asked about, each off by default:
 *  - `setLie`: `transfer` and `transferFrom` move `moveBps` of the amount
 *    (10,000 is the Tether Gold pattern: everything moved, `false`
 *    returned), debit the sender `extraBps` of it on top (burned), and
 *    return `false`;
 *  - `setSurcharge`: an honest transfer also takes `surchargeBps` of the
 *    amount from the sender (burned), and `transferFrom` spends that from
 *    the allowance too: a token that takes more than the amount;
 *  - `setGasBurner`: a transfer to that address burns nearly all the gas it
 *    was given, then reverts;
 *  - `setHiddenFrom`: `balanceOf` and `allowance` read 0 for that caller
 *    only (a token that answers each caller differently).
 */
contract MockWeirdERC20 is ERC20 {
  bool public lying;
  uint256 public moveBps;
  uint256 public extraBps;
  uint256 public surchargeBps;
  address public gasBurnerTo;
  address public hiddenFrom;

  constructor() ERC20("Weird", "WRD") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function setLie(bool lying_, uint256 moveBps_, uint256 extraBps_) external {
    require(moveBps_ <= 10_000, "MockWeirdERC20: moveBps");
    lying = lying_;
    moveBps = moveBps_;
    extraBps = extraBps_;
  }

  function setSurcharge(uint256 bps) external {
    surchargeBps = bps;
  }

  function setGasBurner(address to) external {
    gasBurnerTo = to;
  }

  function setHiddenFrom(address caller) external {
    hiddenFrom = caller;
  }

  function balanceOf(address account) public view override returns (uint256) {
    return hiddenFrom != address(0) && msg.sender == hiddenFrom ? 0 : super.balanceOf(account);
  }

  function allowance(address owner, address spender) public view override returns (uint256) {
    return hiddenFrom != address(0) && msg.sender == hiddenFrom ? 0 : super.allowance(owner, spender);
  }

  function transfer(address to, uint256 value) public override returns (bool) {
    return _move(msg.sender, to, value);
  }

  function transferFrom(address from, address to, uint256 value) public override returns (bool) {
    _spendAllowance(from, msg.sender, value + (lying ? 0 : (value * surchargeBps) / 10_000));
    return _move(from, to, value);
  }

  function _move(address from, address to, uint256 value) private returns (bool) {
    if (to != address(0) && to == gasBurnerTo) {
      while (gasleft() > 5_000) {}
      revert("MockWeirdERC20: gas burned");
    }
    if (!lying) {
      _transfer(from, to, value);
      uint256 surcharge = (value * surchargeBps) / 10_000;
      if (surcharge > 0) _burn(from, surcharge);
      return true;
    }
    uint256 moved = (value * moveBps) / 10_000;
    if (moved > 0) _transfer(from, to, moved);
    uint256 extra = (value * extraBps) / 10_000;
    if (extra > 0) _burn(from, extra);
    return false;
  }
}
