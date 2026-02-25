// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.12;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

contract MockERC1155 is ERC1155 {
  uint256 private tokenId;

  constructor() ERC1155("https://uri.sotatek.works") {}

  function mint(address user, uint256 amount) public {
    _mint(user, tokenId, amount, "");
    tokenId++;
  }
}
