// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.20;

interface ILegacyDeployer {
    function getNextAddress(bytes calldata byteCode, address user) external view returns (address nextLegacy);
    function createLegacy(bytes calldata byteCode, address user)  external returns (address legacyAddress, address guardAddress);

    // EIP-1167 minimal-proxy path. Clones share an implementation contract and
    // cost ~40k gas to deploy vs ~6M for a full bytecode deploy. Salt scheme is
    // identical to the bytecode path (keccak256(user, nonceByUsers[user]+1))
    // so address prediction semantics are unchanged.
    function getNextCloneAddress(address implementation, address user) external view returns (address nextLegacy);
    function cloneLegacy(address implementation, address user) external returns (address legacyAddress);
}
