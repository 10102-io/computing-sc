// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ITokenWhiteList} from "../interfaces/ITokenWhiteList.sol";

struct TokenWhiteListItem {
    address token;
    bool isWhitelisted;
}

contract TokenWhiteList is Ownable, ITokenWhiteList {
    mapping(address => TokenWhiteListItem) public whitelist;
    address[] public whitelistTokens;

    constructor(address initialOwner) Ownable(initialOwner) {}


    function isWhitelisted(address token) public view override returns (bool) {
        return whitelist[token];
    }

    function addToken(address token) external override onlyOwner {
        whitelist[token] = true;
        whitelistTokens.push(token);
    }

    /*
    @dev Remove a token from the whitelist
    @notice The token will be removed from the whitelist. The array will not be modified so that the whitelist can scale. For large lists, removing an item from an array is expensive.
    @param token The address of the token to remove
    */
    function removeToken(address token) external override onlyOwner {
        whiteList[token].isWhitelisted = false;
    }

    /*
    @dev Get the whitelist
    @return The whitelist
    */
    function getWhitelist() external view override returns (address[] memory) {
        // Iterate over the whitelist and return the tokens that are whitelisted
        address[] memory tokens = new address[](whitelistTokens.length);
        uint256 count = 0;
        // Iterate over the array of added tokens and return those that are still whitelisted
        for (uint256 i = 0; i < whitelistTokens.length; i++) {
            if (isWhitelisted(whitelistTokens[i])) { // Check the mapping to see if the token is still whitelisted
                tokens[count] = whitelistTokens[i];
                count++;
            }
        }
        return tokens;
    }