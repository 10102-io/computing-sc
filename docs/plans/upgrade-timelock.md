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

- **PROPOSER + CANCELLER**: the maintainer key
  (`0xfe8bcd055DAf9478137Ecc0E8eb5414B68f4b630`). Moving this to a multisig
  is the natural next hardening step; the timelock makes that a visible,
  queued change when it happens.
- **EXECUTOR**: open (`address(0)`) — anyone can execute a ready operation.
  We cannot censor an operation once its delay has passed.
- **DEFAULT_ADMIN**: the timelock itself. Role grants/revocations and
  `updateDelay` must themselves go through a queued, delayed operation.

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

1. **Deploy the new implementation only.** Either run the hardhat-deploy
   script and let the proxy-upgrade step fail after the impl deploy, or
   deploy the implementation standalone. Verify it on Etherscan. Diff the
   storage layout (`scripts/dump-storage-layouts.ts`) against the live impl.
2. **Schedule** (PowerShell):

   ```powershell
   $env:TL_ACTION="schedule"; $env:TL_PROXY="TransferEOALegacyRouter"; $env:TL_IMPL="0xNEW_IMPL"
   npx hardhat run scripts/timelock-op.ts --network mainnet
   ```

   The script derives a deterministic salt from (target, calldata), prints
   the operation id and eta. Announce the queued upgrade (changelog/Discord)
   — the window is the feature, use it.
3. **Wait out the delay** (48h mainnet / 300s sepolia).
4. **Execute** with the same params and `TL_ACTION="execute"`. Anyone can
   execute a ready operation; the script sends from the deployer for
   convenience.
5. **Reconcile artifacts**: update `deployments/<net>/*_Implementation.json`
   + `<Name>.json.implementation` (`scripts/reconcile-impl-artifacts.ts`),
   `contract-addresses.json`, and run `scripts/audit-deployment-artifacts.ts`.
6. If the deploy script would have replayed `initialize` on upgrade, fix it
   to the `execute: { init: … }` form first (see DEFERRED
   `hardhat-deploy execute.init sweep`) — with the timelock in place the
   upgrade calldata is plain `upgrade(proxy, impl)`, so `upgradeAndCall`
   re-inits are opt-in, never accidental.

Rarely needed — raw calls (e.g. `updateDelay`, or transferring
`DefaultProxyAdmin` ownership onward to a future multisig-owned timelock):
set `TL_TARGET` + `TL_DATA` instead of `TL_PROXY` + `TL_IMPL`.

Cancel a queued op: `TL_ACTION="cancel"` with the same params (or the
operation id via status output), from the canceller key.

## Emergency posture

- Bad implementation about to execute / queued by mistake: **cancel** (instant,
  canceller role).
- Exploit in progress via NEW creates: `setCreatePaused(true)` (instant,
  codeAdmin — deliberately not timelocked).
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
