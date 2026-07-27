// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

interface IEIP712LegacyVerifier {
    function storeLegacyAgreement(address user, address legacyAddress, uint256 timestamp, bytes calldata signature) external;

    /// @notice Record tx-based consent: the authorized recorder attests that
    /// `user` (the tx signer) accepted the active terms as part of the call.
    function recordConsent(address user, uint256 refId) external;
}