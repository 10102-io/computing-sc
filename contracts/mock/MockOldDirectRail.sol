// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The direct ERC-20 rail exactly as every EOA clone before the 2026-11
/// train has it: `try IERC20.transferFrom` with a bool return. Kept only so a
/// spec can show checklist audit M-2: against a token that returns nothing
/// (mainnet USDT) the return-data decode fails outside the `try`, so the call
/// reverts instead of reaching `catch`.
contract MockOldDirectRail {
  function pull(address token_, address from_, address to_, uint256 amount_) external returns (uint256) {
    try IERC20(token_).transferFrom(from_, to_, amount_) {
      return amount_;
    } catch {
      return 0;
    }
  }
}
