// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPayment {
    /**
     * @dev Returns the admin fee percentage
     */
    function getFee() external view returns (uint256);
}