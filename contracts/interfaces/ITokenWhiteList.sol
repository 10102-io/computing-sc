// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

interface ITokenWhiteList {
    function isWhitelisted(address token) external view returns (bool);
    function addToken(address token) external;
    function removeToken(address token) external;
    function getWhitelist() external view returns (address[] memory);
}