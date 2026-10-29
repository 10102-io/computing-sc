// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only ERC-20 with a transfer hook, standing in for a curated token
 * that gained callbacks (ShieldVault audit package Q11). On every transfer
 * or transferFrom it performs one arbitrary call configured by the test
 * (typically back into the vault) and records whether it succeeded, then
 * completes the transfer normally so the outer call's accounting can be
 * asserted. `armOnce` fires the hook on the next transfer only, so a probe
 * can target a specific vault call without re-entering its own claim.
 */
contract MockReentrantShieldToken is ERC20 {
  address public target;
  bytes public payload;
  bool public once;
  uint256 public attempts;
  uint256 public reentrySucceeded;
  bytes public lastRevertData;

  constructor() ERC20("Reentrant Shield", "RSH") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function arm(address target_, bytes calldata payload_) external {
    target = target_;
    payload = payload_;
    once = false;
  }

  function armOnce(address target_, bytes calldata payload_) external {
    target = target_;
    payload = payload_;
    once = true;
  }

  function disarm() external {
    target = address(0);
    delete payload;
    once = false;
  }

  function _hook() private {
    if (target == address(0)) return;
    address t = target;
    bytes memory data = payload;
    if (once) {
      target = address(0);
      delete payload;
      once = false;
    }
    attempts += 1;
    (bool ok, bytes memory ret) = t.call(data);
    if (ok) reentrySucceeded += 1;
    else lastRevertData = ret;
  }

  function _update(address from, address to, uint256 value) internal override {
    // Mint and burn carry no hook; a real token's callbacks fire on transfers.
    if (from != address(0) && to != address(0)) _hook();
    super._update(from, to, value);
  }
}
