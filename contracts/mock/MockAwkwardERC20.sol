// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Test-only ERC-20 with the two behaviours real tokens have that break
 * naive vaults: a transfer fee (burned, `feeBps` of every transfer) and a
 * USDC-style blacklist (transfers to or from a blocked address revert).
 * Both default off; tests switch them on.
 */
contract MockAwkwardERC20 is ERC20 {
    uint256 public feeBps;
    mapping(address => bool) public blocked;

    constructor() ERC20("Awkward", "AWK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint256 bps) external {
        feeBps = bps;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[from] && !blocked[to], "MockAwkwardERC20: blocked");
        if (feeBps == 0 || from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }
}
