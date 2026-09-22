# Agent Context: 10102 Computing Legacy (contracts)

Read this before any non-trivial change. It is the onboarding doc for AI
coding agents in `computing-sc`. The frontend's `computing/AGENTS.md` covers
the app; the conventions below are the ones that protect user funds and
the upgrade path here.

## Repo topology

One of four siblings under a shared parent: `computing` (React app),
`computing-sc` (this repo: Solidity, Hardhat, hardhat-deploy),
`computing-admin`, `computing-subgraph`. Addresses and ABIs flow OUT of this
repo: `contract-addresses.json` is the source of truth for deployed
addresses; `npm run sync-ui` regenerates the frontend's `src/configs/abis/*`
and address constants (write into `output/sync-ui/`, then copy). The
subgraph's ABIs must match the artifacts of whatever is live.

## Commands (PowerShell on the dev machine; never chain with `&&`)

```powershell
npx hardhat compile
npx hardhat test                        # mocha + chai, ~22 spec files under test/
npx hardhat run scripts/dump-storage-layouts.ts   # layout diff before any impl swap
npm run sync-ui:check                   # frontend ABI/address drift
```

There is no CI and no fuzzing harness today; every spec you add is the
whole safety net for that path. Coverage tooling (`solidity-coverage`) is
installed but not wired.

## What is live and how it changes

- Mainnet since Oct 2024. Audited twice: RockSolid Security (legacy suite,
  Jan 2025 report, `Security_Review_Computing_Will.pdf`) and CDSecurity
  (full suite incl. timelocks and premium, Oct 2025). Later riders
  (LegacyPullVault, auto-renew, QuantumRecoveryRegistry, UpgradeTimelock)
  had adversarial review, not a third firm audit. Say so plainly when a
  change lands on those.
- Proxies are hardhat-deploy `OptimizedTransparentProxy` behind
 `DefaultProxyAdmin`, whose owner is `UpgradeTimelock` (OpenZeppelin
 TimelockController, 48h on mainnet, 300s on Sepolia). Every
 implementation swap is: diff storage layouts (`dump-storage-layouts.ts`),
 `scripts/deploy-impl.ts`, `scripts/timelock-op.ts` print then schedule
 (one `TL_BATCH` for a train), wait, execute, `scripts/
 refresh-impl-artifacts.ts`, `npm run sync-ui:check`. Runbook:
 `docs/plans/upgrade-timelock.md`. Role and delay changes:
 `scripts/harden-governance.ts`; any other raw call goes through
 `timelock-op.ts` with `TL_TARGET`+`TL_DATA`. State check any time:
 `scripts/verify-governance.ts`.
- Since 2026-09-22 the timelock vaults are owned by `UpgradeTimelock` and
 `TimeLockRouter` by the governance Safe (`contract-addresses.json`
 `governance` key). The Safe is PROPOSER, the guardian hardware key is the
 only CANCELLER (mainnet batch executes 2026-09-24). Scripts drive the
 threshold-1 Safe with `TL_VIA_SAFE=1`; once it is 2-of-3, use
 `TL_ACTION=print` and Safe{Wallet}.
- Storage: append only, never reorder or retype. The timelock vaults and
  the router have no `__gap`; document any appended variable in the
  contract's storage comment block (see `TimeLockRouter.sol`
  `sponsorNonce` / `consentVerifier` / `createPaused`).
- EOA legacies are EIP-1167 clones: existing clones pin their
  implementation and vault forever. A behaviour fix for existing legacies
  is a new implementation for NEW creates plus user communication, never a
  hot swap.
- Claims, check-ins, deletes and withdrawals are never pausable. Keep it
  that way; `setCreatePaused` is the only circuit breaker and it stops new
  creates only.

## Conventions that exist for a reason

- **Bundle contract changes into one upgrade train.** Each swap churns
  `contract-addresses.json`, frontend ABIs, the subgraph and a 48h queue.
  Riders wait for the train; the train does not leave for one rider.
- **Signed authorisations bind everything the relayer could tamper
  with.** The EIP-712 structs (`WithdrawAuth`, `ClaimAuth`, `AliveAuth`)
  include every call argument that changes where or how funds move. If you
  add an argument, add it to the typehash and bump the domain version so
  old signatures fail loudly.
- **Payee is the signer** unless a signed field says otherwise. The vaults'
  `withdraw` is `external` and not `onlyRouter`: anyone may trigger a
  payout to the rightful recipient, which is safe only while the payee is
  fixed by the lock. Any destination override must be bound in the
  signature and applied only on the router path.
- **Events are the subgraph's API.** Changing an existing event's signature
  breaks indexing of history; add a new event instead and keep the old one
  emitting. Check `computing-subgraph/subgraph.yaml` for which events are
  handled before touching one.
- **Amounts and durations are `uint256`/`uint128` with explicit casts**;
  the frontend passes `bigint`. Percentages are basis points scaled by
  10,000.
- **Never commit `.env`, keys, or signed payloads.** Deployer and
  maintainer keys live in the founder's password manager and on Railway
  only.

## Git and releases

- `dev` is the working branch; `main` is kept identical by fast-forward.
  Releases are annotated CalVer tags (`vYYYY.MM.DD`) plus a dated
  `CHANGELOG.md` entry (this file has dated entries, no `[Unreleased]`).
- One commit per day on `dev`, amended, subject `type: item one, item two`
  (lowercase `feat`/`fix`/`chore`/`docs`/`refactor`, no process words).
  Feature branches carry detail while in flight; milestone branches
  (`feat/create-flow-v2`, `feat/legacy-pull-vault`) are kept.
- `main` here rejects force pushes (branch protection). So amend the day's
  commit only while it is not yet on `main`; once it has been fast-
  forwarded, further same-day work is a second commit, not an amend.
  Fast-forward `main` at the end of the day, not after every push.
- Mainnet deploys that ship from `dev` before a tag get an
  `[Unreleased on main, already live on mainnet]` note in `CHANGELOG.md`.

## Useful files

- `docs/plans/upgrade-timelock.md`: how upgrades and role changes run.
- `docs/plans/deployment-procedure.md`: fresh deploys and init scripts.
- `docs/plans/create-flow-v2.md`: the legacy v2 architecture record.
- `docs/CONTRACTS_REFERENCE.md`: what each contract is for.
- `docs/plans/round-2026-09.md`: the current round (governance, destination
 wallet, the trains behind them) with its execution log at the top.
- `scripts/timelock-op.ts`, `scripts/harden-governance.ts`,
 `scripts/verify-governance.ts`, `scripts/deploy-impl.ts`,
 `scripts/dump-storage-layouts.ts`, `scripts/refresh-impl-artifacts.ts`,
 `scripts/smoke-payto.ts`, `scripts/verify-etherscan-status.ts`,
 `scripts/sync-ui.ts`, `scripts/utils/safe.ts`.
- Cross-repo plans live in `computing/docs/plans/` and the deferred log in
  `computing/docs/DEFERRED.md`; check both before proposing "we should
  also".
