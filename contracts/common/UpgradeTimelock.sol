// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title UpgradeTimelock
 * @notice The timelocked owner of `DefaultProxyAdmin` — every proxy
 * implementation swap in the protocol must be publicly queued here and wait
 * out the delay before it can execute.
 *
 * Why (ROADMAP track 11): the vault's immutability and the attestor's
 * on-chain bounds are only as strong as the proxy admin above them. With a
 * single hot EOA owning `DefaultProxyAdmin`, one key could re-implement every
 * router silently. Routing upgrades through this timelock converts every
 * "immutable / bounded" claim into something a stranger can verify: any
 * upgrade emits `CallScheduled` and is visible for the full delay before it
 * can take effect, giving users time to inspect the queued implementation —
 * and, if they disagree, to exit (claims, check-ins, deletes and withdrawals
 * are never pausable).
 *
 * Role layout (see docs/plans/upgrade-timelock.md):
 * - PROPOSER + CANCELLER: the maintainer key. A future step is moving this
 *   to a multisig; the timelock itself makes that a visible, queued change.
 * - EXECUTOR: open (address(0)) — once the delay has passed, anyone can
 *   execute; we cannot censor a ready operation.
 * - ADMIN: the timelock itself (self-administered). Role changes and delay
 *   changes must themselves go through a queued, delayed operation.
 *
 * Honest limit, stated out loud: this is a transparency window, not
 * multi-party control. A compromised maintainer key can still queue a
 * malicious upgrade — but it cannot make it land silently or instantly.
 */
contract UpgradeTimelock is TimelockController {
  constructor(
    uint256 minDelay_,
    address[] memory proposers_,
    address[] memory executors_
  ) TimelockController(minDelay_, proposers_, executors_, address(0)) {}
}
