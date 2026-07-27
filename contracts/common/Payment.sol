// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


contract Payment is AccessControl {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_DENOMINATOR = 10000;
    bytes32 public constant WITHDRAWER = keccak256("WITHDRAWER");
    bytes32 public constant OPERATOR = keccak256("OPERATOR");
    uint256 public  claimFee; 
    bool isActive; // if false, no fee will be charged

    event ClaimFeeUpdated(uint256 claimFee, bool isActive);
    event WithdrawERC20(address token, address to, uint256 amount);
    event WithdrawAllERC20(address token, address to);
    event WithdrawETH(address to, uint256 amount);
    event WithdrawAllETH(address to);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function setClaimFee(uint256 _claimFee, bool _isActive) external onlyRole(OPERATOR){
        require(_claimFee < FEE_DENOMINATOR, "Claim fee must be less than FEE_DENOMINATOR");
        claimFee = _claimFee;
        isActive = _isActive;
        emit ClaimFeeUpdated(_claimFee, _isActive);
    }

    /**
     * @dev Returns the admin fee percentage
     */
    function getFee() external view returns (uint256) {
        return isActive ? claimFee : 0;
    }

    function withdrawERC20(address _token, address _to, uint256 _amount) external onlyRole(WITHDRAWER){
        IERC20(_token).safeTransfer(_to, _amount);
        emit WithdrawERC20(_token, _to, _amount);
    }

    function withdrawAllERC20(address _token, address _to) external onlyRole(WITHDRAWER){
        uint256 balance = IERC20(_token).balanceOf(address(this));
        IERC20(_token).safeTransfer(_to, balance);
        emit WithdrawAllERC20(_token, _to);
    }

    function withdrawETH(address _to, uint256 _amount) external onlyRole(WITHDRAWER){
        (bool success, ) = payable(_to).call{value: _amount}("");
        require(success, "ETH transfer failed");
        emit WithdrawETH(_to, _amount);
    }

    function withdrawAllETH(address _to) external onlyRole(WITHDRAWER){
        uint256 balance = address(this).balance;
        (bool success, ) = payable(_to).call{value: balance}("");
        require(success, "ETH transfer failed");
        emit WithdrawAllETH(_to);
    }

    receive() external payable {}

}