// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.20;

import {SafeGuard} from "../SafeGuard.sol";
// TransferLegacy (Safe-source variant) was hard-sunset in v2026.05.18.
// The storage slot `transferLegacyRouter` below is preserved for
// upgradeability — removing it would shift every slot beneath it on
// existing proxies. The slot can now be wired to address(0) on fresh
// deployments; existing mainnet/Sepolia deployments retain whatever
// dormant router address they were initialised with.
import {TransferEOALegacy} from "../forwarding/TransferLegacyEOAContract.sol";
import {MultisigLegacy} from "../inheritance/MultisigLegacyContract.sol";
import {ILegacyDeployer} from "../interfaces/ILegacyDeployer.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

contract LegacyDeployer is OwnableUpgradeable, ILegacyDeployer {
  address public multisigLegacyRouter;
  address public transferLegacyRouter;
  address public transferEOALegacyRouter;

  mapping(address => uint256) internal nonceByUsers;

  error InvalidParam();

  modifier onlyRouter() {
    require(
      msg.sender == transferLegacyRouter || msg.sender == transferEOALegacyRouter || msg.sender == multisigLegacyRouter || msg.sender == owner(),
      "Router only"
    );
    _;
  }
  function initialize() public initializer {
    __Ownable_init(msg.sender);
  }

  function setParams(address _multisigLegacyRouter, address _transferLegacyRouter, address _transferEOALegacyRouter) public onlyOwner {
    // _transferLegacyRouter is allowed to be address(0) since the
    // Safe-source Transfer flow was sunset (v2026.05.18). The other two
    // routers are still required to be non-zero — they back the
    // EOA-source Transfer and Multisig flows that remain active.
    if (_multisigLegacyRouter == address(0) || _transferEOALegacyRouter == address(0)) revert InvalidParam();
    multisigLegacyRouter = _multisigLegacyRouter;
    transferLegacyRouter = _transferLegacyRouter;
    transferEOALegacyRouter = _transferEOALegacyRouter;
  }

  function getNextAddress(bytes calldata byteCode, address user) external view returns (address nextLegacy) {
    uint256 nextNonce = nonceByUsers[user] + 1;
    bytes32 salt = keccak256(abi.encodePacked(user, nextNonce));
    bytes32 bytecodeHash = keccak256(byteCode);
    return Create2.computeAddress(salt, bytecodeHash);
  }

  function createLegacy(bytes calldata byteCode, address user) external onlyRouter returns (address legacyAddress, address guardAddress) {
    nonceByUsers[user] += 1;
    bytes32 salt = keccak256(abi.encodePacked(user, nonceByUsers[user]));
    legacyAddress = Create2.deploy(0, salt, byteCode);
    if (msg.sender != transferEOALegacyRouter) {
      guardAddress = Create2.deploy(0, salt, type(SafeGuard).creationCode);
    }
  }

  /**
   * @dev Predict the address of the next EIP-1167 minimal-proxy clone that
   * `cloneLegacy(implementation, user)` would produce. Uses the same salt scheme
   * as `getNextAddress` so callers can migrate without changing nonce semantics.
   */
  function getNextCloneAddress(address implementation, address user) external view returns (address) {
    uint256 nextNonce = nonceByUsers[user] + 1;
    bytes32 salt = keccak256(abi.encodePacked(user, nextNonce));
    return Clones.predictDeterministicAddress(implementation, salt, address(this));
  }

  /**
   * @dev Deploy a deterministic EIP-1167 minimal-proxy pointing at `implementation`.
   * Caller is expected to invoke the implementation's initializer after this returns.
   * Only usable by the EOA router today; Multisig / Transfer routers still rely on
   * `createLegacy(bytes, address)` for their SafeGuard-paired deployments.
   */
  function cloneLegacy(address implementation, address user) external onlyRouter returns (address legacyAddress) {
    require(msg.sender == transferEOALegacyRouter, "Clone path is EOA-only");
    require(implementation != address(0), "Implementation=0");
    nonceByUsers[user] += 1;
    bytes32 salt = keccak256(abi.encodePacked(user, nonceByUsers[user]));
    legacyAddress = Clones.cloneDeterministic(implementation, salt);
  }
}
