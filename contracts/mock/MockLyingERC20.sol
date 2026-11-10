// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only ERC-20 whose `transfer` can be switched to report failure
 * (return `false`, no revert) after moving `moveBps` of the amount: 10,000
 * is the Tether Gold pattern (everything moved, `false` returned), 0 an
 * old-style failure that moves nothing, anything between a partial move.
 * `transferFrom` stays honest, so deposits work. ShieldVault checklist
 * audit 2026-11, SV-L1.
 */
contract MockLyingERC20 is ERC20 {
  bool public lying;
  uint256 public moveBps;

  constructor() ERC20("Lying", "LIE") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function setLie(bool lying_, uint256 moveBps_) external {
    require(moveBps_ <= 10_000, "MockLyingERC20: moveBps");
    lying = lying_;
    moveBps = moveBps_;
  }

  function transfer(address to, uint256 value) public override returns (bool) {
    if (!lying) return super.transfer(to, value);
    uint256 moved = (value * moveBps) / 10_000;
    if (moved > 0) _transfer(msg.sender, to, moved);
    return false;
  }
}
