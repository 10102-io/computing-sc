// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev ERC-20 whose `transferFrom` can be switched to return `false` without
/// reverting and without moving anything (old ZRX/BAT-style failure). A claim
/// rail that ignores the return value would count such a "transfer" as paid;
/// SafeERC20's try variant must report it as failed.
contract MockFalseReturnERC20 {
  string public constant name = "FalseReturn";
  string public constant symbol = "FLS";
  uint8 public constant decimals = 18;
  uint256 public totalSupply;
  bool public failTransfers;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    totalSupply += amount;
  }

  function setFailTransfers(bool fail_) external {
    failTransfers = fail_;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    if (failTransfers || balanceOf[msg.sender] < amount) return false;
    balanceOf[msg.sender] -= amount;
    balanceOf[to] += amount;
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    if (failTransfers || balanceOf[from] < amount || allowance[from][msg.sender] < amount) return false;
    allowance[from][msg.sender] -= amount;
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
    return true;
  }
}
