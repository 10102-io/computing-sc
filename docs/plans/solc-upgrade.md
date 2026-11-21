# Solidity Compiler Upgrade Plan

**Status**: 0.8.35 landed on `feat/create-flow-v2` (2026-07-23) and is on mainnet for everything deployed since 2026-07-27. No further contract train is planned (founder, 2026-11-19), so nothing is redeployed for a compiler change; if contracts are deployed again, they compile with 0.8.39 or later, as below (planned 2026-11-12 as 0.8.38)  
**Priority**: Low (no functional impact today)  
**Created**: 2026-04-10

## Outcome (2026-07-23)

- solc `0.8.20` (+`0.8.22` secondary) → single `0.8.35` entry (Apr 2026 release,
  ~3 months of soak; deliberately not the 2-week-old 0.8.36). All 42 exact
  `pragma solidity 0.8.20` files bumped; carets untouched.
- `evmVersion` pinned explicitly to `cancun` so bytecode no longer drifts when
  solc changes its default target (previous builds targeted paris implicitly).
- Hardhat `2.26.3` → `2.28.6` (pinned exact; 2.29.0 was 2 days old).
- **Storage layout verification**: `scripts/dump-storage-layouts.ts` (new)
  dumps label/slot/offset/type for all proxied contracts + clone impls.
  Pre/post diff: **identical for every contract** (only AST type-id
  renumbering inside type names, which is cosmetic).
- Full suite 112/112 green. Sizes: clone 14.22 KiB, router 16.33 KiB — 0.8.35
  codegen is ~0.2 KiB larger per contract than 0.8.20; ample headroom.
- **Finding**: Hardhat ≥2.28 enforces the EIP-7825 transaction gas cap
  (16,777,216 — live on mainnet via Fusaka). Tests that passed
  `gasLimit: 20_000_000` to `setLegacyCreationCode` needed lowering to 16M
  (actual usage ~10M). Operationally: the full-bytecode fallback deploy path
  still fits under the cap, but only barely at ~15–16M estimate — one more
  reason the EIP-1167 clone path stays the default.
- The vendored `SignatureCheckerLite` swap back to OZ `SignatureChecker`
  (needs ≥0.8.24) was done the same day (`29d53b4`, 2026-07-23): the
  vendored file and its inline TODO(deferred) are gone from `contracts/`.

## If contracts are deployed again: 0.8.35 to 0.8.39 (planned 2026-11-12, release updated 2026-11-19)

0.8.35 has eight known bugs today, 0.8.39 (2026-11-19) has none; 0.8.38
(2026-10-22), the release this plan named first, now carries the two
recursive struct entries that came with 0.8.39. None of the eight is found
to apply to what is deployed (`docs/security/compiler-known-bugs.md`), so
nothing is redeployed for this: the bump comes with the next deploy of
contracts, if there is one, for the contracts it deploys. Legacies that
exist keep their code.

The Safe legacy fix of 2026-11-19 (two implementations,
`docs/plans/safe-legacy-guard-2026-11.md`) did not take the bump with it,
on purpose: 0.8.39 was hours old, a compiler change moves the bytecode of
61 of the 68 contracts and wants the whole list below, and the fix was not
to wait for that. Its code was checked against every known bug of 0.8.35
instead (`docs/security/compiler-known-bugs.md` section 10).

- One `version` in `hardhat.config.ts` (the compiler entry and the two
  clone overrides) and the exact pragmas. `evmVersion` stays `cancun`.
- Storage layouts before and after (`scripts/dump-storage-layouts.ts`):
  must be identical.
- The bytecode will change, and that is expected: under 0.8.37 eight
  contracts differ from 0.8.35, under 0.8.38 59 of 66, under 0.8.39 61 of
  the 68 the tree holds since 2026-11-19
  (`scripts/compiler-bugs/tree-version-diff.mjs 0.8.36 0.8.37 0.8.38 0.8.39`
  shows which; `ir-diff.mjs` shows why). The contract sizes move by a few
  bytes: check the v3 clone against the 24,576-byte limit.
- The whole suite, coverage, the Foundry fuzz and invariant suites and
  Slither on the new build (Aderyn was retired on 2026-11-13; decide on a
  second analyser before this train).
- `scripts/check-clone-reproducible.ts` for both clones, then the list of
  known bugs again for the release chosen
  (`scripts/compiler-bugs/known-bugs.mjs 0.8.39`): if a later release is
  out by then and has soaked, take that one. A release gets a few weeks
  before we build on it (0.8.35 had three months).
- Foundry: `foundry.toml` pins the same solc; keep the two in step.

## Background (2026-04)

The project currently uses solc 0.8.20 (with a secondary 0.8.22 compiler entry).
Etherscan flags four low-severity known compiler bugs for 0.8.20:

- `LostStorageArrayWriteOnSlotOverflow` — unrealistic slot positions required
- `VerbatimInvalidDeduplication` — requires `verbatim` in assembly (not used)
- `FullInlinerNonExpressionSplitArgumentEvaluationOrder` — viaIR optimizer edge case
- `MissingSideEffectsOnSelectorAccess` — `.selector` on side-effect expressions

None of these affect the current contracts in practice, but upgrading to the
latest stable solc (0.8.28+) would eliminate the warnings and bring access to
newer language features and gas optimizations.

## Scope

- Bump both compiler entries in `hardhat.config.ts` (0.8.20 → latest, 0.8.22 → latest)
- Audit all `pragma solidity` directives in contracts
- Run full test suite — fix any new warnings or compilation errors
- **Storage layout verification** for every upgradeable proxy contract:
  - MultisigLegacyRouter
  - TransferEOALegacyRouter
  - TimeLockRouter
  - PremiumRegistry, PremiumSetting, PremiumMail* (proxied)
  - LegacyDeployer, EIP712LegacyVerifier (proxied)
  - Any other proxied contracts (cross-check against `contract-addresses.json`)
- Use `hardhat-upgrades` storage layout checks or manual slot diffing
- Deploy to Sepolia, verify all contracts, run integration tests
- Deploy to mainnet

## Risks

- `viaIR: true` behavior may change between compiler versions → bytecode diff
- OpenZeppelin dependency compatibility (check supported solc range)
- Storage layout must remain identical for all proxy-upgradeable contracts
- Gas costs may shift (optimizer changes between versions)

## Prerequisites

- All current feature work and bug fixes landed and stable
- Full test coverage for affected contracts
- A clean Sepolia environment to validate against

## Notes

This should be done as an isolated task — not combined with feature work or
contract logic changes, so any regressions are clearly attributable to the
compiler change.
