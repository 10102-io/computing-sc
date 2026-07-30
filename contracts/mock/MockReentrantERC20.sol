// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev ERC-777-style reentrancy PROBE for the EOA claim path. On the first
 * `transferFrom` (the claim pulling tokens from the owner), it attempts to
 * re-enter `router.activeLegacy` — exactly what a malicious/callback-bearing
 * token could do mid-distribution — records whether the re-entry succeeded,
 * then completes the transfer normally so the outer claim's accounting can
 * be asserted. With the router's ReentrancyGuardTransient in place the
 * re-entry must fail and distribution must happen exactly once.
 */
contract MockReentrantERC20 is ERC20 {
  address public router;
  uint256 public legacyId;
  bool public reentryAttempted;
  bool public reentrySucceeded;

  constructor() ERC20("Reentrant", "RNT") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function setAttack(address router_, uint256 legacyId_) external {
    router = router_;
    legacyId = legacyId_;
  }

  function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
    if (router != address(0) && !reentryAttempted) {
      reentryAttempted = true;
      address[] memory assets = new address[](1);
      assets[0] = address(this);
      (bool ok, ) = router.call(
        abi.encodeWithSignature("activeLegacy(uint256,address[],bool)", legacyId, assets, false)
      );
      reentrySucceeded = ok;
    }
    return super.transferFrom(from, to, amount);
  }
}
