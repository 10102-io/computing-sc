# Upgrade timelock — design record + ops runbook

ROADMAP track 11 ("the single highest-leverage item not in flight",
strategist review 2026-07-30). Shipped 2026-08-06.

## What shipped

`DefaultProxyAdmin` — the owner of every upgradeable proxy in the protocol —
is no longer a hot EOA. It is owned by an `UpgradeTimelock`
(`contracts/common/UpgradeTimelock.sol`, a thin subclass of OpenZeppelin
`TimelockController`): every implementation swap must be publicly scheduled,
wait out the delay, and only then execute.

| Network | UpgradeTimelock | minDelay | Deploy block |
|---|---|---|---|
| mainnet | `0xc0Fee69ffAA1d62D701Bb277031CEc0d98AFA4Ad` (Etherscan-verified) | 48h (172800s) | 25697124 |
| sepolia | `0xFE949165f70becE8EaeA9f39140F377aF47f0875` (Etherscan-verified) | 300s (QA) | 11432452 |

Ownership transfers executed 2026-08-06:

- mainnet `DefaultProxyAdmin` (`0xA41299408EB78D67B9b599e38E3259C11A005145`)
  → timelock, tx `0xf3d430066f4df5444a1a7118c77d107219764d41bb3b010e727653a883e8900d`
- sepolia `DefaultProxyAdmin` (`0x26e78E0A15ebBC48065Ed0527D74F28D1B53a1B6`)
  → timelock, tx `0x5644302760f43c9b61a914a0fb89d7b6e00e06312eb3fefb3409ad5ca22b1f44`

The full schedule → wait → execute cycle was rehearsed on Sepolia against the
real `DefaultProxyAdmin` and the real EOA router proxy (no-op upgrade
re-setting the current implementation): schedule tx
`0x7f6812e402bb4a38870354e9f0ec2021b611c459e10141b060e2009b8a9769e2`,
execute tx
`0x692a5c75c821e7a28cc6de17bdb977ca111b27b41baeeb32ea664a04f8e4101d`.
Router state verified healthy after the cycle.

## Role layout

Hardened on 2026-09-22 (`docs/plans/round-2026-09.md`, Track A). Read the
live table any time with `npx hardhat run scripts/verify-governance.ts
--network mainnet` (phase `interim` is the expected state until the Safe
is 2-of-3; `final` afterwards).

- **PROPOSER**: the governance Safe
  (`0x60B3da49f05E21a1fcD7e210075A23b75939C3eA`, Safe 1.5.0; threshold 1
  to start, owners = the guardian hardware key and the maintainer EOA;
  to be raised to 2-of-3) AND, until the Safe is 2-of-3, the maintainer
  EOA (`0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630`) so scripts can queue
  routine upgrades. Sepolia: same Safe address, same owners.
- **CANCELLER**: the guardian hardware key
  (`0x7B61dD775422f465D6b9f28C8EFEE39263ef2579`), never connected to a
  browser wallet extension. It can stop anything queued and can queue
  nothing. The maintainer EOA's CANCELLER is revoked in the same batch
  (mainnet batch executable from 2026-09-24 ~21:02 UTC; Sepolia done).
- **EXECUTOR**: open (`address(0)`) — anyone can execute a ready operation.
  We cannot censor an operation once its delay has passed.
- **DEFAULT_ADMIN**: the timelock itself. Role grants/revocations and
  `updateDelay` must themselves go through a queued, delayed operation.

Who owns what, after the same day:

| Contract | Owner / admin | Effect |
|---|---|---|
| `DefaultProxyAdmin` | `UpgradeTimelock` | every implementation swap is queued |
| `TimelockERC20/721/1155` | `UpgradeTimelock` | `setUniswapRouter`, `setRouterAddresses` are queued |
| `TimeLockRouter` | governance Safe | `setCreatePaused`, `setUniswapRouter`, `setTimelock`, `setTokenWhitelist`, `setConsentVerifier` run from the Safe |
| `TransferEOALegacyRouter` codeAdmin | maintainer EOA | unchanged: `_codeAdmin` has no setter, only a reinitializer; moving it rides the next EOA-router upgrade (`upgradeAndCall` + `initializeV4`) |
| `TokenWhiteList`, `Payment`, premium stack, `EIP712LegacyVerifier`, `LegacyDeployer` | maintainer EOA | unchanged this round; move to the Safe once it is 2-of-3 and the ops scripts drive it |

While the Safe has threshold 1 and the EOA is an owner, scripts act
through it with `TL_VIA_SAFE=1` (Safe `execTransaction` with a
pre-validated owner signature, `scripts/utils/safe.ts`). Once the
threshold is 2 that path stops working by construction; use
`TL_ACTION=print` and paste the calldata into Safe{Wallet}'s Transaction
Builder.

## What is / is not timelocked (the honest split)

**Timelocked** — `DefaultProxyAdmin` operations: implementation swaps for
every proxy (routers, premium stack, timelock-asset contracts, verifier,
banner…) and `changeProxyAdmin` / `transferOwnership` of the admin itself.
This is the big blast radius: an implementation swap can change behavior for
EXISTING user state.

**Not timelocked** (deliberately):

- The EOA router's `codeAdmin` levers: `setPullVault`,
  `setLegacyImplementation`, `setActivityAttestor`, `setCreatePaused`.
  `setCreatePaused` is an emergency circuit breaker — it must work in
  minutes, not 48 hours; and the rotation levers only affect NEW creates
  (existing clones pin their implementation and vault at create time).
- Ownable operational setters on the proxies (whitelists, plan config,
  banner text, watcher config…).

The user-safety invariant that makes the split honest: **claims, check-ins,
deletes and withdrawals are never pausable** — a hostile or compromised
operational key can degrade the experience for new users, but cannot trap
existing users' assets; and any change to existing-legacy behavior needs an
implementation swap, which is now publicly visible for 48h first.

## Honest limit

This is a transparency window, not multi-party control. A compromised
maintainer key can still QUEUE a malicious upgrade — but it cannot land it
silently or instantly. The 48h window is the time for us (canceller) and for
users (exit paths) to react. The reminder-worker's timelock watch
(`services/reminder-worker/src/timelock-watch.ts` in the `computing` repo)
alerts on every `CallScheduled` / `CallExecuted` / `Cancelled` /
`MinDelayChange` event.

## Ops runbook — how to upgrade a proxy now

Direct hardhat-deploy proxy upgrades from the deployer key **revert** now
(the deployer no longer owns `DefaultProxyAdmin`). The flow is:

1. **Diff storage layouts first.** `npx hardhat run
   scripts/dump-storage-layouts.ts` on the committed source (`OUT=
   storage-layouts-before.json`) and on the change; the two files must be
   byte-identical for every contract you touch. Type identifiers are
   normalised, so a difference is a real slot/offset/label change.
2. **Deploy the new implementations only** (never touches the proxies):

   ```powershell
   $env:IMPLS="TimeLockRouter,TimelockERC20"; npx hardhat run scripts/deploy-impl.ts --network mainnet
   ```

   Verifies on Etherscan, records `<Name>.pendingImplementation` in
   `contract-addresses.json`, writes `output/upgrade-batch-<network>.json`.
3. **Print, then schedule** the batch. One batch = one id = one window,
   and the upgrades execute atomically:

   ```powershell
   $env:TL_ACTION="print";    $env:TL_BATCH="output/upgrade-batch-mainnet.json"; npx hardhat run scripts/timelock-op.ts --network mainnet
   $env:TL_ACTION="schedule"; $env:TL_VIA_SAFE="1"; npx hardhat run scripts/timelock-op.ts --network mainnet
   ```

   `print` shows id, salt, eta and the `scheduleBatch` / `executeBatch` /
   `cancel` calldata for Safe{Wallet}. `TL_VIA_SAFE=1` sends the schedule
   through the Safe (PROPOSER) while it is threshold 1; drop it to send
   from the EOA while the EOA still holds PROPOSER. A single upgrade still
   works with `TL_PROXY` + `TL_IMPL`. Announce the queued upgrade
   (changelog/Discord); the window is the feature, use it.
4. **Wait out the delay** (48h mainnet / 300s sepolia). The reminder
   worker's timelock watch emails on `CallScheduled`.
5. **Execute** with the same params and `TL_ACTION="execute"`. Anyone can
   execute a ready operation; the script sends from the deployer for
   convenience and never routes execution through the Safe.
6. **Reconcile artifacts**: `$env:IMPLS="..."; npx hardhat run
   scripts/refresh-impl-artifacts.ts --network mainnet` reads the live
   EIP-1967 implementation, promotes `pendingImplementation` to
   `implementation`, and rewrites `deployments/<net>/<Name>.json` and
   `<Name>_Implementation.json`. Then `npm run sync-ui:check` (it compares
   the frontend's ABI modules too) and `--write` if it drifts. Finally
   `npx hardhat run scripts/verify-etherscan-status.ts --network mainnet`:
   it confirms every live and pending implementation is source-verified
   and that Etherscan's proxy record points at the live implementation
   (`ES_FIX=1` re-submits a stale record so "Read as Proxy" shows the new
   ABI).
7. If the deploy script would have replayed `initialize` on upgrade, fix it
   to the `execute: { init: … }` form first (see DEFERRED
   `hardhat-deploy execute.init sweep`) — with the timelock in place the
   upgrade calldata is plain `upgrade(proxy, impl)`, so `upgradeAndCall`
   re-inits are opt-in, never accidental.

Role and delay changes: `scripts/harden-governance.ts` (`GOV_STEP`, dry run
unless `GOV_EXECUTE=1`) encodes the steps of round-2026-09 and writes the
matching `output/governance-<step>-<network>.json` for `TL_BATCH`. Any
other raw call (`updateDelay`, a role grant, an ownership transfer): set
`TL_TARGET` + `TL_DATA`, or list several as `{target, data}` items in a
`TL_BATCH` file.

Cancel a queued op: `TL_ACTION="cancel"` with the same params, from a
CANCELLER (the guardian). From a hardware wallet without a script: the
`cancel` calldata printed by `TL_ACTION=print`, sent to the timelock
address with value 0 (Etherscan "Write Contract" → `cancel(id)` works
too).

## Emergency posture

- Bad implementation about to execute / queued by mistake: **cancel** (instant,
  from the guardian hardware key, the only CANCELLER once the 2026-09-22
  batch executes).
- Compromised Safe signer: the guardian cancels whatever gets queued; the
  Safe's other owners rotate the signer. Compromised guardian: it can only
  cancel, never queue; the Safe queues `revokeRole(CANCELLER, guardian)` +
  `grantRole(CANCELLER, new)` (48h). Lost Safe: no new schedules until the
  signers are recovered; user exits are unaffected (nothing users do is
  pausable).
- A scheduled `setRouterAddresses` or `setUniswapRouter` on a timelock
  vault is upgrade-equivalent: since the vaults' router-only `withdrawTo`
  (2026-09-22) whoever is `routerAddresses` can pay any unlocked lock to
  any address, and the swap router decides where ETH-gift proceeds go.
  Treat such an operation exactly like a hostile implementation swap:
  the guardian cancels unless it was announced. `verify-governance.ts`
  asserts both values.
- Exploit in progress via NEW creates: `setCreatePaused(true)` (instant;
  EOA router: codeAdmin key; timelock router: the Safe — deliberately not
  timelocked).
- Exploit in EXISTING clones: clones are immutable; the fix ships as a new
  implementation for new creates + user comms to delete/exit affected
  legacies. The timelock does not slow this down materially because existing
  clones never hot-swap anyway.
- Compromised maintainer key: cancel anything queued, then queue
  `transferOwnership` of `DefaultProxyAdmin` to a fresh timelock with clean
  roles (48h exposure window; alerting is the tripwire).

## Published policy

User-facing policy page: `computing-docs/architecture/upgrade-policy.md`
(docs.10102.io → Architecture → Upgrade Policy). Keep the two in sync —
this file is the engineering record, that one is the public promise.
