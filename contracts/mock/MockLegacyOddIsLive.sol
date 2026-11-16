// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

/// @dev A legacy the router can claim on whose `isLive()` does not answer
/// with a clean bool. The router asks `isLive()` before a claim to decide
/// whether the claim releases the owner's create flag; this stand-in shows
/// that the claim goes through whatever comes back
/// (test/RouterCreateFlag.spec.ts). Its code is planted at a real legacy's
/// address, so the owner and the answer are immutables.
contract MockLegacyOddIsLive {
  /// What `isLive()` does: revert, return nothing, return the word 2, or return false.
  enum Answer {
    Reverts,
    Empty,
    Two,
    NotLive
  }

  address private immutable OWNER;
  Answer private immutable ANSWER;

  event Claimed(address beneficiary);

  constructor(address owner_, Answer answer_) {
    OWNER = owner_;
    ANSWER = answer_;
  }

  function activeLegacy(address[] calldata, bool, address bene_) external {
    emit Claimed(bene_);
  }

  function activeLegacyAndUnswap(address[] calldata, address bene_, uint256, uint256) external {
    emit Claimed(bene_);
  }

  function eoaStorageToken() external pure returns (address) {
    return address(0);
  }

  function getBeneficiaryLayer(address) external pure returns (uint8) {
    return 1;
  }

  function getLayer() external pure returns (uint8) {
    return 1;
  }

  function getLegacyOwner() external view returns (address) {
    return OWNER;
  }

  /// `isLive()` is not declared, so it lands here with every other unknown call.
  fallback() external {
    Answer answer = ANSWER;
    if (answer == Answer.Reverts) revert();
    if (answer == Answer.Empty) return;
    uint256 word = answer == Answer.Two ? 2 : 0;
    assembly ("memory-safe") {
      mstore(0, word)
      return(0, 32)
    }
  }
}
