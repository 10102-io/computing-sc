// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

/// @dev Mock of a non-standard ERC-20 — mainnet Tether (USDT) — whose
/// `transfer` / `transferFrom` / `approve` return NOTHING instead of a bool.
/// A raw `bool ok = token.transferFrom(...)` against such a token reverts at
/// the ABI-decode step under solc 0.8, which is exactly the bug
/// `PremiumRegistry.subcribeWithUSDT` had before switching to SafeERC20.
/// Used by the registry regression test to prove the SafeERC20 path tolerates
/// these tokens.
contract MockNoReturnERC20 {
  string public name;
  string public symbol;
  uint8 public immutable decimals;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(string memory _name, string memory _symbol, uint8 _decimals) {
    name = _name;
    symbol = _symbol;
    decimals = _decimals;
  }

  function mint(address to, uint256 amount) external {
    balanceOf[to] += amount;
    totalSupply += amount;
  }

  // NOTE: deliberately no `returns (bool)` on the three mutating methods —
  // this mirrors mainnet USDT and is the whole point of the mock.
  function approve(address spender, uint256 amount) external {
    allowance[msg.sender][spender] = amount;
  }

  function transfer(address to, uint256 amount) external {
    _transfer(msg.sender, to, amount);
  }

  function transferFrom(address from, address to, uint256 amount) external {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, "allowance");
    if (allowed != type(uint256).max) {
      allowance[from][msg.sender] = allowed - amount;
    }
    _transfer(from, to, amount);
  }

  function _transfer(address from, address to, uint256 amount) internal {
    require(balanceOf[from] >= amount, "balance");
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
  }
}
