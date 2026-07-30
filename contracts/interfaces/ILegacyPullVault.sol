// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/**
 * @dev Surface of the LegacyPullVault used by the EOA router (bind at create)
 * and the legacy clones (pull at claim, release at delete). See
 * contracts/common/LegacyPullVault.sol for the full trust-model rationale.
 */
interface ILegacyPullVault {
  function bind(address owner_, address legacy_) external;

  function release(address owner_) external;

  function pull(address owner_, address token_, address to_, uint160 amount_) external;

  function boundLegacy(address owner_) external view returns (address);

  function cloneCodehash() external view returns (bytes32);
}

/**
 * @dev The one router getter the legacy clone needs to discover the vault.
 * Kept separate so the clone doesn't have to import the full router surface.
 */
interface IPullVaultProvider {
  function pullVault() external view returns (address);
}
