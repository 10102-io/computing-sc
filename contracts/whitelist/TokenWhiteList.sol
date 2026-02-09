// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ITokenWhiteList} from "../interfaces/ITokenWhiteList.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct TokenWhiteListItem {
    address token;
    bool isWhitelisted;
    bool inList; // true once token has been pushed to tokenList; never cleared so re-add does not duplicate
}

contract TokenWhiteList is AccessControl, ITokenWhiteList {
    error InvalidAdminAddress();
    error AlreadyWhitelisted(address token);
    error NotERC20(address token);

    event TokenAdded(address token);
    event TokenRemoved(address token);

    mapping(address => TokenWhiteListItem) public whitelistLookup; // Mapping of token addresses to their current whitelist status.
    address[] public tokenList; // List of all tokens that have previously been added to the whitelist. Some may have been subsequently de-whitelisted.

    constructor(address initialAdmin) {
        if (initialAdmin == address(0)) revert InvalidAdminAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    }


    /*
    @dev Check if a token is whitelisted
    @param token The address of the token to check
    @return True if the token is whitelisted, false otherwise
    */
    function isWhitelisted(address token) public view override returns (bool) {
        return whitelistLookup[token].isWhitelisted;
    }

    /*
    @dev Add a token to the whitelist
    @param token The address of the token to add
    */
    function addToken(address token) external override onlyRole(DEFAULT_ADMIN_ROLE) onlyERC20(token) {
        if (whitelistLookup[token].isWhitelisted) revert AlreadyWhitelisted(token);
        whitelistLookup[token].isWhitelisted = true;
        if (!whitelistLookup[token].inList) {
            whitelistLookup[token].inList = true;
            tokenList.push(token);
        }
        emit TokenAdded(token);
    }

    /*
    @dev Remove a token from the whitelist
    @notice The token will be removed from the whitelist. The array will not be modified so that the whitelist can scale. For large lists, removing an item from an array is expensive.
    @param token The address of the token to remove
    */
    function removeToken(address token) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!whitelistLookup[token].isWhitelisted) return;
        // De-whitelist the token
        whitelistLookup[token].isWhitelisted = false;
        emit TokenRemoved(token);
    }

    /*
    @dev Get the whitelist
    @return The whitelist
    */
    function getWhitelist() external view override returns (address[] memory) {
        address[] memory tokens = new address[](tokenList.length);
        uint256 count = 0;
        // Iterate over the array of added tokens and return those that are still whitelisted
        for (uint256 i = 0; i < tokenList.length; i++) {
            if (isWhitelisted(tokenList[i])) { // Check the mapping to see if the token is still whitelisted
                tokens[count] = tokenList[i];
                count++;
            }
        }
        return tokens;
    }

    function isERC20(address token) internal view returns (bool) {      
        try IERC20(token).totalSupply() returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    modifier onlyERC20(address token) {
        if (!isERC20(token)) revert NotERC20(token);
        _;
    }
}