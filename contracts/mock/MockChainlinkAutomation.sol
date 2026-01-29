// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct RegistrationParams {
    string name;
    bytes encryptedEmail;
    address upkeepContract;
    uint32 gasLimit;
    address adminAddress;
    uint8 triggerType;
    bytes checkData;
    bytes triggerConfig;
    bytes offchainConfig;
    uint96 amount;
}

contract MockAutomationRegistrar {
    IERC20 public linkToken;
    uint256 public nextUpkeepId = 1;

    constructor(address _linkToken) {
        linkToken = IERC20(_linkToken);
    }

    function registerUpkeep(
        RegistrationParams calldata params
    ) external returns (uint256) {
        if (params.amount > 0) {
            linkToken.transferFrom(msg.sender, address(this), params.amount);
        }
        return nextUpkeepId++;
    }
}

contract MockKeeperRegistryMaster {
    address public defaultForwarder;
    mapping(uint256 => uint96) public balances;

    constructor(address _forwarder) {
        defaultForwarder = _forwarder;
    }

    function addFunds(uint256 id, uint96 amount) external {
        balances[id] += amount;
    }

    function getForwarder(uint256) external view returns (address) {
        return defaultForwarder;
    }

    function getMinBalance(uint256) external pure returns (uint96) {
        return 0;
    }

    function getMinBalanceForUpkeep(uint256) external pure returns (uint96) {
        return 0;
    }

    function getBalance(uint256 id) external view returns (uint96) {
        return balances[id];
    }
}
