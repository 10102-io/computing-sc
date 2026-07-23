// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.35;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract LegacyToken is ERC20, Ownable {
  constructor(string memory name, string memory symbol) ERC20(name, symbol) Ownable(msg.sender) {}

  function mint(address to, uint256 amount) public {
    _mint(to, amount);
  }
}
