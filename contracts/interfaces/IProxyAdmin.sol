// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;


interface ProxyAmin {
    function upgradeAndCall(
        address proxy,
        address implementation,
        bytes memory data
    ) external;

    function upgradeTo(address newImplementation) external;
    function upgrade(address proxy, address implementation) external;

    function upgradeToAndCall(address newImplementation, bytes calldata data)external payable;
}
