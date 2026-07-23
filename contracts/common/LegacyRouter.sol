// SPDX-License-Identifier: UNLICENSED
// OpenZeppelin Contracts v5.x
pragma solidity 0.8.35;

contract LegacyRouter {
  /* State variable */
  // guard storage slot in safe wallet
  uint256 public constant BENEFICIARIES_LIMIT = 32;

  /* Internal function */
  /**
   * @dev Check beneficiaries limit
   * @param numBeneficiaries_ number of beneficiaries
   */
  function _checkNumBeneficiariesLimit(uint256 numBeneficiaries_) internal pure returns (bool) {
    if (numBeneficiaries_ == 0 || numBeneficiaries_ > BENEFICIARIES_LIMIT) {
      return false;
    }
    return true;
  }
}
