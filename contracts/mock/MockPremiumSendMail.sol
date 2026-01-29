// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {NotifyLib} from "../libraries/NotifyLib.sol";
import {IPremiumSendMail} from "../interfaces/IPremiumSendMail.sol";

/// @notice No-op mock for all three mail contracts (BeforeActivation, ReadyToActivate, Activated)
contract MockPremiumSendMail is IPremiumSendMail {
    function sendEmailFromManager(address, NotifyLib.NotifyType) external {}
    function sendEmailBeforeActivationToOwner(string memory, string memory, uint256, uint256, address[] memory, string memory) external {}
    function sendEmailBeforeActivationToBeneficiary(string[] memory, string memory, uint256, string[] memory, uint256, address) external {}
    function sendEmailBeforeLayer2ToLayer1(string[] memory, string[] memory, string memory, uint256, uint256, address) external {}
    function sendEmailBeforeLayer2ToLayer2(string memory, string memory, string memory, uint256) external {}
    function sendEmailBeforeLayer3ToLayer12(string[] memory, string[] memory, string memory, uint256, uint256, address) external {}
    function sendEmailBeforeLayer3ToLayer3(string memory, string memory, string memory, uint256) external {}
    function sendEmailReadyToActivateToLayer1(string[] memory, string[] memory, string memory, uint256, address) external {}
    function sendEmailReadyToActivateLayer2ToLayer1(string[] memory, string[] memory, address, string memory, uint256) external {}
    function sendEmailReadyToActivateLayer2ToLayer2(string memory, string memory, string memory, uint256, address) external {}
    function sendEmailReadyToActivateLayer3ToLayer12(string[] memory, string[] memory, string memory, uint256, address) external {}
    function sendEmailReadyToActivateLayer3ToLayer3(string memory, string memory, string memory, uint256, address) external {}
    function sendEmailActivatedToLayer1(string memory, string memory, string memory, address[] memory, uint256[] memory, string[] memory) external {}
    function sendEmailActivatedToLayer2(string memory, string memory, string memory, address[] memory, uint256[] memory, string[] memory) external {}
    function sendMailOwnerResetToBene(string[] memory, string[] memory, string memory) external {}
    function sendMailActivatedMultisig(string[] memory, string[] memory, string memory, address) external {}
    function sendEmailActivatedToBene(string memory, string memory, string memory, address[] memory, uint256[] memory, string[] memory, address, bool) external {}
    function sendEmailContractActivatedToOwner(string memory, string memory, address, uint256, address, NotifyLib.ListAsset[] memory, NotifyLib.BeneReceived[] memory, address, bool) external {}
    function sendActivatedMutisigToOwner(string memory, string memory, address, address, address, string[] memory, address[] memory) external {}
}
