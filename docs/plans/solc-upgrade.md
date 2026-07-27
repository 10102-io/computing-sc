# Solidity Compiler Upgrade Plan

**Status**: Landed on `feat/create-flow-v2` (2026-07-23) — ships with the v2 redeploy  
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
  (needs ≥0.8.24) rides the next commit, per its inline TODO(deferred).

## Background

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
