// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

interface IPayment {
    /**
     * @dev Returns the admin fee percentage
     */
    function getFee() external view returns (uint256);
}