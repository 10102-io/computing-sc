// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Minimal WETH9-shaped mock for tests: `deposit` mints 1:1 against the
 * ETH sent, `withdraw` burns and pays ETH back. Exists so the ETH-gift path
 * (router wraps at create, vault unwraps at withdraw) can run end to end in
 * Hardhat; the plain `ERC20Token` mock has no `withdraw`.
 */
contract MockWETH9 is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "MockWETH9: ETH transfer failed");
    }
}
