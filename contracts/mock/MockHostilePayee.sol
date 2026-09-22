// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @dev Test-only payee for the destination-wallet claim path. Two modes:
 *
 *  - reentry: every receive hook (ETH, ERC-721, ERC-1155) performs one
 *    arbitrary call configured by the test (typically back into the router
 *    or a vault) and records whether it succeeded. Used to prove the vaults'
 *    reentrancy guards hold across the router-mediated path.
 *  - reject: every receive hook reverts, so a claim that names this payee
 *    must revert as a whole and leave the signer's nonce untouched.
 */
contract MockHostilePayee is IERC721Receiver, IERC1155Receiver {
    address public target;
    bytes public payload;
    bool public rejectAll;
    uint256 public attempts;
    uint256 public reentrySucceeded;

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        rejectAll = false;
    }

    function setRejectAll(bool value) external {
        rejectAll = value;
    }

    function _hook() internal {
        if (rejectAll) revert("MockHostilePayee: rejected");
        if (target == address(0)) return;
        attempts += 1;
        (bool ok, ) = target.call(payload);
        if (ok) reentrySucceeded += 1;
    }

    receive() external payable {
        _hook();
    }

    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        _hook();
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external override returns (bytes4) {
        _hook();
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        override
        returns (bytes4)
    {
        _hook();
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return
            interfaceId == type(IERC721Receiver).interfaceId ||
            interfaceId == type(IERC1155Receiver).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }
}
