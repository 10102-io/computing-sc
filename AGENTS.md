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

# ShieldVault (v2 and v3) and QuantumRecoveryRegistry evidence (docs/security/).
# The npm scripts use POSIX env syntax for CI; in PowerShell set the variable
# first. Coverage instruments artifacts/ in place: run no other Hardhat command
# meanwhile, or the later specs count against uninstrumented code.
$env:HARDHAT_NO_FORK='1'; npx hardhat coverage --testfiles "test/{ShieldVault,ShieldVault.branches,ShieldVaultV3,QuantumRecoveryRegistry}.spec.ts"
git submodule update --init             # once: lib/forge-std for the fuzz suite
forge test --match-path "test/foundry/**" -vv   # needs Foundry v1.8.6
slither contracts/shield/ShieldVault.sol --compile-force-framework solc --solc-remaps "@openzeppelin=node_modules/@openzeppelin" --solc-args "--via-ir --optimize --optimize-runs 200 --evm-version cancun" --filter-paths node_modules --triage-database slither.db.json --fail-medium   # and ShieldVaultV3.sol
```

CI (`.github/workflows/security.yml`, since 2026-10-29) runs the Hardhat
suite, the `deployments/` pointer audit, coverage with thresholds for
ShieldVault (v2 and v3) and the registry, Slither and Aderyn, and the Foundry fuzz and
invariant suite on every PR and every push
to `dev` and `main`. The checks are informational, not required: a red run
blocks nothing, `[skip ci]` in a commit message skips one, and the workflow
can be disabled from the Actions tab. Slither needs Foundry on the PATH
(crytic-compile reads `forge config` whenever `foundry.toml` exists). A new
Slither finding at Medium or above is triaged in
`docs/security/static-analysis.md` and `slither.db.json`, never silenced by
editing deployed contract source. Outside those two contracts, every spec
you add is still the whole safety net for that path.

## What is live and how it changes

- Mainnet since Oct 2024. Audited twice: RockSolid Security (legacy suite,
  Jan 2025 report, `Security_Review_Computing_Will.pdf`) and CDSecurity
  (full suite incl. timelocks and premium, Oct 2025). Later riders
 (LegacyPullVault, auto-renew, QuantumRecoveryRegistry, UpgradeTimelock,
 ShieldVault) had adversarial review, not a third firm audit, and so did
 wave A of the 2026-11 train (live 2026-11-07: LegacyPullVaultV2, the new
 clone, the timelocked router levers, PremiumRegistry coupons and
 referrals, the PremiumSetting and verifier changes), which also had our
 own checklist pass. Wave B (legacy v3, NftCollectionWhiteList) and
 ShieldVault v3 are live on Sepolia since 2026-11-10; the founder moved
 their mainnet deploy ahead of the external review (2026-11-10, risk
 accepted). On mainnet since 2026-11-11: ShieldVault v3 is deployed
 (`ShieldVaultV3`) and takes new holdings (the Safe paused deposits on v2,
 exits there keep working), and wave B is deployed and scheduled in the timelock
 (executable from 2026-11-13 20:37 UTC; until it executes, its addresses
 sit under `train202611` and the router creates the wave A clone). Say so
 plainly when a change lands on those. ShieldVault and the registry also carry tooling
  evidence (`docs/security/tooling-report.md`): internally reviewed and
  tooling-verified, still not independently audited.
- Compilers on mainnet: solc 0.8.35 for everything deployed since
  2026-07-27, 0.8.20 before (34 of the 48 legacies run 0.8.20 code for
  good), 0.8.10 for hardhat-deploy's proxies. Every known compiler bug of
  those versions is assessed in `docs/security/compiler-known-bugs.md`
  (2026-11-12): each contract rebuilt to the bytes on the chain, none found
  affected, and the old clone targets and first legacies verified on
  Sourcify and Etherscan. The optimizer bug fixed in 0.8.38 is the one answered by an
  indication (the compiler team's nightly comparison), not a proof. On a
  new solc release or compiler bug notice, run
  `scripts/compiler-bugs/known-bugs.mjs` first. The next train compiles
  with 0.8.38 (`docs/plans/solc-upgrade.md`).
- Proxies are hardhat-deploy `OptimizedTransparentProxy` behind
 `DefaultProxyAdmin`, whose owner is `UpgradeTimelock` (OpenZeppelin
 TimelockController, 48h on mainnet, 300s on Sepolia). Every
 implementation swap is: diff storage layouts (`dump-storage-layouts.ts`),
 `scripts/deploy-impl.ts`, `scripts/timelock-op.ts` print then schedule
 (one `TL_BATCH` for a train), wait and rehearse the scheduled operation
 on a fork (`scripts/rehearse-timelock-op.ts`: no key, prints every value
 the execution changes), execute, `scripts/
 refresh-impl-artifacts.ts`, `npm run sync-ui:check`. Runbook:
 `docs/plans/upgrade-timelock.md`. Role and delay changes:
 `scripts/harden-governance.ts`; any other raw call goes through
 `timelock-op.ts` with `TL_TARGET`+`TL_DATA`. State check any time:
 `scripts/verify-governance.ts`.
- Since 2026-09-22 the timelock vaults are owned by `UpgradeTimelock` and
 `TimeLockRouter` by the governance Safe (`contract-addresses.json`
 `governance` key). The Safe is PROPOSER, the guardian hardware key is the
 only CANCELLER (mainnet batch executes 2026-09-24). Since 2026-09-29
 every `Payment` role (claim fee, fee and Premium treasury) is on the
 Safe too, and the deployer holds none (`scripts/handover-payment-roles.ts`).
 The deployer keeps day-to-day ops (plan prices, Premium grants, banners,
 token list); the Safe is co-admin there and owns PremiumSetting
 (`scripts/add-safe-admin.ts`), so it can revoke a leaked deployer key.
 Since 2026-11-07 the Safe is also the EOA router's code admin, and the
 router's rotation levers (`setLegacyImplementation`, `setPullVault`, a
 non-zero attestor) answer only to `UpgradeTimelock`. Scripts drive the
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
  creates only. The other instant lever, the attestor kill switch
  (`setActivityAttestor(0)`), only stops automatic renewals. Both are the
  Safe's, through `scripts/safe-call.ts`.

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
- **Never commit `.env`, keys, or signed payloads.** The deployer
  (maintainer) key lives in the founder's password manager only, never in
  Railway. Railway holds the worker's hot keys (attestor and fee relayer,
  autopilot, Turnkey API), which Railway's 2026-10-21 security incident
  showed can leak: keep anything with on-chain power out of it.

## Git and releases

- `dev` is the working branch; `main` is kept identical by fast-forward.
  Releases are annotated CalVer tags (`vYYYY.MM.DD`) plus a dated
  `CHANGELOG.md` entry (this file has dated entries, no `[Unreleased]`).
- One commit per day on `dev`, amended, subject `type: item one, item two`
  (lowercase `feat`/`fix`/`chore`/`docs`/`refactor`, no process words).
  Feature branches carry detail while in flight; milestone branches
  (`feat/create-flow-v2`, `feat/legacy-pull-vault`) are kept.
- Same-day work is always one commit: amend the day's commit on `dev`.
  `main` takes fast-forwards only, once, at the end of the day and never
  after every push, so an amend never has to re-point it. Work that lands
  after `main` moved goes into the next day's commit. (Force pushes on
  `main` were open on 2026-11-10 and 2026-11-11 for the deploy days only,
  founder.)
- Mainnet deploys that ship from `dev` before a tag get an
  `[Unreleased on main, already live on mainnet]` note in `CHANGELOG.md`.

## Useful files

- `docs/plans/upgrade-timelock.md`: how upgrades and role changes run.
- `docs/plans/deployment-procedure.md`: fresh deploys and init scripts.
- `docs/plans/create-flow-v2.md`: the legacy v2 architecture record.
- `docs/plans/shield-vault.md`: ShieldVault spec, threat model, review.
- `docs/CONTRACTS_REFERENCE.md`: what each contract is for.
- `docs/security/tooling-report.md`, `docs/security/static-analysis.md`:
  coverage, fuzz and static-analysis evidence for ShieldVault and the
  registry, with every triaged finding.
- `docs/security/compiler-known-bugs.md`: every known solc bug against
  every contract on mainnet, with the evidence and its limits; the scripts
  behind it are `scripts/compiler-bugs/` (read-only, plain Node).
- `docs/security/wave-b-audit-scope.md`: the external review scope for
 legacy v3 (wave B); its tooling evidence is `tooling-report.md` section 8
 and the Foundry suite `test/foundry/LegacyV3*`.
- `docs/security/checklist-audit-2026-11.md`: the checklist audit of the
  unaudited riders, with each finding's status; its "Left" column is the
  input to the next contract train.
- `docs/plans/train-2026-11.md`: the current contract train (wave A live
 2026-11-07, wave B on Sepolia and scheduled on mainnet), with its
 execution log, runbooks and the follow-up table for the sibling repos.
 The cross-repo order of work is `computing/docs/plans/round-2026-11.md`.
- `docs/plans/round-2026-09.md`: the 2026-09 round (governance, destination
 wallet, the trains behind them) with its execution log at the top.
- `scripts/safe-call.ts`: the Safe's instant emergency stops (pause new
  creates, stop renewals), printed for Safe{Wallet} or sent at threshold 1.
- `scripts/timelock-op.ts`, `scripts/rehearse-timelock-op.ts`,
 `scripts/harden-governance.ts`,
 `scripts/verify-governance.ts`, `scripts/deploy-impl.ts`,
 `scripts/dump-storage-layouts.ts`, `scripts/refresh-impl-artifacts.ts`,
 `scripts/smoke-payto.ts`, `scripts/verify-etherscan-status.ts`,
 `scripts/sync-ui.ts`, `scripts/utils/safe.ts`.
- Cross-repo plans live in `computing/docs/plans/` and the deferred log in
  `computing/docs/DEFERRED.md`; check both before proposing "we should
  also".
