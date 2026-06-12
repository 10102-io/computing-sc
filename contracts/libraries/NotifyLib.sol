// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/Strings.sol";

library NotifyLib {
    struct BeneReceived {
    string name;
    address beneAddress;
    string[] listAssetName;
    uint256[] listAmount;
  }

  struct ListAsset {
    address listToken;
    uint256 listAmount;
    string listAssetName;
  }
  
  enum NotifyType {
    None, //0
    BeforeActivation, //1
    BeforeLayer2, //2
    BeforeLayer3, //3
    ReadyToActivate, //4
    Layer2ReadyToActivate, //5
    Layer3ReadyToActivate, //6
    Activated, //7
    ContractActivated, //8
    OwnerReset //9
  }

  enum RecipientType {
    Owner,
    Beneficiary,
    Secondline,
    Thirdline
  }


  
}
